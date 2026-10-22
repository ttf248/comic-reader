package middleware

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/gofiber/fiber/v2"
)

type fixedResolver map[string]string

func (r fixedResolver) Resolve(id string) (string, bool) {
	path, ok := r[id]
	return path, ok
}

func TestResourceParamRejectsDirectoryReplacedAfterScan(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	album := filepath.Join(root, "album")
	if err := os.Mkdir(album, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(album, "page.jpg")
	if err := os.WriteFile(path, []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "page.jpg"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, validator := PathSafetyMiddleware([]string{root})
	app := fiber.New()
	app.Get("/:id", ResourceParam(fixedResolver{"file": path}, validator), func(c *fiber.Ctx) error {
		return c.SendString("allowed")
	})
	before, err := app.Test(httptest.NewRequest("GET", "/file", nil))
	if err != nil {
		t.Fatal(err)
	}
	before.Body.Close()
	if before.StatusCode != 200 {
		t.Fatalf("before=%d", before.StatusCode)
	}
	if err := os.Rename(album, filepath.Join(root, "original")); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		cmd := exec.Command("powershell", "-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:TEST_LINK -Target $env:TEST_TARGET -ErrorAction Stop | Out-Null")
		cmd.Env = append(os.Environ(), "TEST_LINK="+album, "TEST_TARGET="+outside)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("junction: %v %s", err, output)
		}
	} else if err := os.Symlink(outside, album); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(album) })
	after, err := app.Test(httptest.NewRequest("GET", "/file", nil))
	if err != nil {
		t.Fatal(err)
	}
	after.Body.Close()
	if after.StatusCode != 404 {
		t.Fatalf("replaced directory returned %d", after.StatusCode)
	}
}

type snapshotResolver struct {
	path     string
	snapshot any
}

func (r snapshotResolver) Resolve(id string) (string, bool) {
	return r.path, id == "a_valid"
}

func (r snapshotResolver) ResolveWithSnapshot(id string) (string, any, bool) {
	return r.path, r.snapshot, id == "a_valid"
}

func TestResourceParamRevalidatesCurrentRoots(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "album", "page.jpg")
	out := filepath.Join(t.TempDir(), "secret.jpg")
	_, state := PathSafetyMiddleware([]string{root})

	app := fiber.New()
	app.Get("/:id", ResourceParam(fixedResolver{"inside": inside, "outside": out}, state), func(c *fiber.Ctx) error {
		return c.SendString(SafePath(c))
	})

	insideResponse, err := app.Test(httptest.NewRequest("GET", "/inside", nil))
	if err != nil || insideResponse.StatusCode != fiber.StatusOK {
		t.Fatalf("inside response=(%v,%v)", insideResponse, err)
	}
	outsideResponse, err := app.Test(httptest.NewRequest("GET", "/outside", nil))
	if err != nil {
		t.Fatal(err)
	}
	if outsideResponse.StatusCode != fiber.StatusNotFound {
		t.Fatalf("outside status=%d", outsideResponse.StatusCode)
	}
}

func TestResourceParamPinsResolverSnapshot(t *testing.T) {
	root := t.TempDir()
	marker := &struct{ revision int }{revision: 7}
	app := fiber.New()
	_, validator := PathSafetyMiddleware([]string{root})
	app.Get("/albums/:id", ResourceParam(snapshotResolver{
		path: filepath.Join(root, "album"), snapshot: marker,
	}, validator), func(c *fiber.Ctx) error {
		if ResourceSnapshot(c) != marker {
			return fiber.ErrInternalServerError
		}
		return c.SendStatus(fiber.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodGet, "/albums/a_valid", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != fiber.StatusNoContent {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}
