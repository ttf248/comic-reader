package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

type videoInfoFields struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Dir    string `json:"dir"`
	Size   int64  `json:"size"`
	Format string `json:"format"`
}

type videoBatchResult struct {
	Items []struct {
		ID   string           `json:"id"`
		Code string           `json:"code"`
		Info *videoInfoFields `json:"info"`
	} `json:"items"`
}

func videoInfoTestApp(root string, catalog *services.ResourceCatalog, afterResolve ...fiber.Handler) *fiber.App {
	app := fiber.New()
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	handlers := []fiber.Handler{middleware.ResourceParam(catalog, safety)}
	handlers = append(handlers, afterResolve...)
	handlers = append(handlers, VideoInfoHandler(nil, nil, catalog))
	app.Get("/api/videos/:id/info", handlers...)
	app.Post("/api/videos/info/batch", VideoInfoBatchHandler(nil, nil, catalog, safety))
	return app
}

func queryVideoInfoBatch(t *testing.T, app *fiber.App, ids []string) videoBatchResult {
	t.Helper()
	payload, err := json.Marshal(struct {
		IDs []string `json:"ids"`
	}{ids})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/videos/info/batch", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("batch status=%d", res.StatusCode)
	}
	var result videoBatchResult
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != len(ids) {
		t.Fatalf("batch length=%d want %d", len(result.Items), len(ids))
	}
	return result
}

func TestVideoInfoUsesFileIDAndParentDirectory(t *testing.T) {
	for _, relative := range []string{"picture.png", "相册 [100%]/子目录/picture.png"} {
		t.Run(relative, func(t *testing.T) {
			root, picture, catalog := mediaInfoFixture(t, relative)
			path := filepath.Join(filepath.Dir(picture), "clip.webm")
			id := catalog.ExternalID(path, services.ResourceFile)
			app := videoInfoTestApp(root, catalog)
			res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/videos/"+id+"/info", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("single status=%d", res.StatusCode)
			}
			var single videoInfoFields
			if err := json.NewDecoder(res.Body).Decode(&single); err != nil {
				t.Fatal(err)
			}
			want := videoInfoFields{
				Path: id, Name: "clip.webm", Size: 5, Format: ".webm",
				Dir: filepath.ToSlash(filepath.Join(filepath.Base(root), filepath.Dir(filepath.FromSlash(relative)))),
			}
			if single != want {
				t.Errorf("single=%+v want %+v", single, want)
			}
			batch := queryVideoInfoBatch(t, app, []string{id})
			if batch.Items[0].ID != id || batch.Items[0].Code != "" || batch.Items[0].Info == nil || *batch.Items[0].Info != want {
				t.Fatalf("batch item=%+v want %+v", batch.Items[0], want)
			}
		})
	}
}

func TestVideoInfoRejectsWrongTypesAndKeepsPartialBatch(t *testing.T) {
	root, picture, catalog := mediaInfoFixture(t, "album.webm/picture.png")
	app := videoInfoTestApp(root, catalog)
	videoID := catalog.ExternalID(filepath.Join(filepath.Dir(picture), "clip.webm"), services.ResourceFile)
	cases := []struct {
		name   string
		id     string
		status int
		code   string
	}{
		{"root", catalog.ExternalID(root, services.ResourceRoot), http.StatusBadRequest, "invalid_resource_kind"},
		{"video", videoID, http.StatusOK, ""},
		{"collection", catalog.ExternalID(root, services.ResourceCollection), http.StatusBadRequest, "invalid_resource_kind"},
		{"album", catalog.ExternalID(filepath.Dir(picture), services.ResourceAlbum), http.StatusBadRequest, "invalid_resource_kind"},
		{"image", catalog.ExternalID(picture, services.ResourceFile), http.StatusUnsupportedMediaType, "unsupported_video_format"},
		{"missing", "f_unknown", http.StatusNotFound, "resource_not_found"},
		{"duplicate video", videoID, http.StatusOK, ""},
	}
	ids := make([]string, len(cases))
	for index, tc := range cases {
		ids[index] = tc.id
		t.Run(tc.name, func(t *testing.T) {
			if tc.id == "" {
				t.Fatal("missing fixture id")
			}
			res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/videos/"+tc.id+"/info", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var response struct {
				Code string `json:"code"`
			}
			if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != tc.status || response.Code != tc.code {
				t.Fatalf("single status/code=%d/%q want %d/%q", res.StatusCode, response.Code, tc.status, tc.code)
			}
		})
	}
	batch := queryVideoInfoBatch(t, app, ids)
	for index, item := range batch.Items {
		want := cases[index]
		if item.ID != want.id || item.Code != want.code || (item.Info != nil) != (want.code == "") {
			t.Errorf("batch[%d]=%+v want id=%s code=%s", index, item, want.id, want.code)
		}
	}
}

func TestVideoInfoKeepsResolvedSnapshot(t *testing.T) {
	root, picture, catalog := mediaInfoFixture(t, "album/picture.png")
	id := catalog.ExternalID(filepath.Join(filepath.Dir(picture), "clip.webm"), services.ResourceFile)
	app := videoInfoTestApp(root, catalog, func(c *fiber.Ctx) error {
		catalog.Clear()
		return c.Next()
	})
	res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/videos/"+id+"/info", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var info videoInfoFields
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK || info.Path != id || info.Dir != filepath.Base(root)+"/album" {
		t.Fatalf("metadata mixed catalog versions: status=%d info=%+v", res.StatusCode, info)
	}
}

func TestVideoInfoRejectsDisappearedFiles(t *testing.T) {
	for _, replacement := range []string{"deleted", "directory"} {
		t.Run(replacement, func(t *testing.T) {
			root, picture, catalog := mediaInfoFixture(t, "album/picture.png")
			path := filepath.Join(filepath.Dir(picture), "clip.webm")
			id := catalog.ExternalID(path, services.ResourceFile)
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if replacement == "directory" {
				if err := os.Mkdir(path, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			app := videoInfoTestApp(root, catalog)
			res, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/videos/"+id+"/info", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusNotFound {
				t.Errorf("single status=%d", res.StatusCode)
			}
			batch := queryVideoInfoBatch(t, app, []string{id})
			if batch.Items[0].Code != "video_not_found" || batch.Items[0].Info != nil {
				t.Fatalf("batch item=%+v", batch.Items[0])
			}
		})
	}
}

func TestVideoInfoBatchRevalidatesCurrentRoots(t *testing.T) {
	root, picture, catalog := mediaInfoFixture(t, "album/picture.png")
	id := catalog.ExternalID(filepath.Join(filepath.Dir(picture), "clip.webm"), services.ResourceFile)
	_, safety := middleware.PathSafetyMiddleware([]string{root})
	app := fiber.New()
	app.Post("/api/videos/info/batch", VideoInfoBatchHandler(nil, nil, catalog, safety))
	before := queryVideoInfoBatch(t, app, []string{id})
	if before.Items[0].Info == nil {
		t.Fatal("valid file was rejected")
	}
	safety.SetRoots([]string{t.TempDir()})
	after := queryVideoInfoBatch(t, app, []string{id})
	if after.Items[0].Code != "resource_not_found" || after.Items[0].Info != nil {
		t.Fatalf("removed root remained readable: %+v", after.Items[0])
	}
}

func TestVideoInfoBatchRequiresPathValidator(t *testing.T) {
	_, picture, catalog := mediaInfoFixture(t, "album/picture.png")
	id := catalog.ExternalID(filepath.Join(filepath.Dir(picture), "clip.webm"), services.ResourceFile)
	payload, err := json.Marshal(struct {
		IDs []string `json:"ids"`
	}{[]string{id}})
	if err != nil {
		t.Fatal(err)
	}
	app := fiber.New()
	app.Post("/api/videos/info/batch", VideoInfoBatchHandler(nil, nil, catalog, nil))
	req := httptest.NewRequest(http.MethodPost, "/api/videos/info/batch", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var response struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusInternalServerError || response.Code != "video_info_unavailable" {
		t.Fatalf("missing validator was accepted: status=%d code=%s", res.StatusCode, response.Code)
	}
}
