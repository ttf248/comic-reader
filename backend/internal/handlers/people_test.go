package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

type peopleHandlerAnalyzer struct{}

func (peopleHandlerAnalyzer) Type() string    { return services.AIJobTypeFace }
func (peopleHandlerAnalyzer) Version() string { return services.FaceAnalyzerVersion }
func (peopleHandlerAnalyzer) Analyze(context.Context, io.ReadSeeker) (services.AIAnalysisOutput, error) {
	return peopleHandlerOutput(0), nil
}
func (peopleHandlerAnalyzer) AnalyzeBatch(_ context.Context, inputs []services.AIAnalysisInput) ([]services.AIAnalysisOutput, error) {
	outputs := make([]services.AIAnalysisOutput, len(inputs))
	for index, input := range inputs {
		axis := 0
		if filepath.Base(input.Path) == "other.jpg" {
			axis = 1
		}
		outputs[index] = peopleHandlerOutput(axis)
	}
	return outputs, nil
}

func peopleHandlerOutput(axis int) services.AIAnalysisOutput {
	vector := make([]float32, 128)
	vector[axis] = 1
	data, _ := json.Marshal(struct {
		Faces []struct {
			Box       []float32 `json:"box"`
			Score     float32   `json:"score"`
			Embedding []float32 `json:"embedding"`
		} `json:"faces"`
	}{Faces: []struct {
		Box       []float32 `json:"box"`
		Score     float32   `json:"score"`
		Embedding []float32 `json:"embedding"`
	}{{Box: []float32{0.1, 0.1, 0.4, 0.5}, Score: 0.99, Embedding: vector}}})
	return services.AIAnalysisOutput{Status: "faces_found", Data: data, Fields: []string{services.AIFieldFaces}}
}

func TestPeopleHTTPGroupingCorrectionsAndClear(t *testing.T) {
	root := t.TempDir()
	albumPath := filepath.Join(root, "photos")
	if err := os.MkdirAll(albumPath, 0o755); err != nil {
		t.Fatal(err)
	}
	files := []string{
		filepath.Join(albumPath, "first.jpg"),
		filepath.Join(albumPath, "second.jpg"),
		filepath.Join(albumPath, "other.jpg"),
	}
	for _, path := range files {
		if err := os.WriteFile(path, []byte("temporary test image"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	catalog := services.NewResourceCatalog()
	catalog.Publish(&models.ScanResult{
		Roots: []string{root},
		Albums: []models.Album{{
			Type: "album", Name: "人物测试", Path: albumPath, SourceRoot: root,
			ContentKind: string(models.ContentKindPhoto), ImageFiles: files, CoverImage: files[0],
		}},
	}, []string{root})
	safety, safetyState := middleware.PathSafetyMiddleware([]string{root}, catalog)
	people, err := services.OpenPeopleService(filepath.Join(t.TempDir(), "state", "people.json"), filepath.Join(t.TempDir(), "derived", "people-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := people.Sync(nil); err != nil {
		t.Fatal(err)
	}
	jobs, err := services.NewAIJobService(services.AIJobServiceOptions{
		StatePath:    filepath.Join(t.TempDir(), "state", "ai_jobs.json"),
		MetadataDir:  filepath.Join(t.TempDir(), "derived", "ai"),
		Catalog:      catalog,
		ValidatePath: safetyState.Validate,
		Analyzers:    []services.AIAnalyzer{services.MetadataAnalyzer{}, peopleHandlerAnalyzer{}},
		OnRecordsCommitted: func(records []services.AIAnalysisRecord) {
			if err := people.ApplyRecords(records); err != nil {
				t.Errorf("apply face records: %v", err)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := jobs.Shutdown(ctx); err != nil {
			t.Errorf("AI job shutdown: %v", err)
		}
	})
	if _, err := jobs.SetPeopleEnabled(true); err != nil {
		t.Fatal(err)
	}
	job, _, err := jobs.Start(services.AIJobTypeFace, services.AIJobModeFull)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, exists := jobs.Get(job.ID)
		if exists && (current.Status == services.AIJobStatusCompleted || current.Status == services.AIJobStatusFailed) {
			if current.Status != services.AIJobStatusCompleted {
				t.Fatalf("face job failed: %+v", current)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if current, _ := jobs.Get(job.ID); current.Status != services.AIJobStatusCompleted {
		t.Fatalf("face job did not complete: %+v", current)
	}

	app := fiber.New()
	api := app.Group("/api")
	api.Use(safety)
	api.Get("/people", PeopleHandler(people, jobs, catalog, safetyState.Validate))
	api.Delete("/people", PeopleHandler(people, jobs, catalog, safetyState.Validate))
	api.Get("/people/:id/media", PersonMediaHandler(people, jobs, catalog, safetyState.Validate))
	api.Put("/people/:id", PersonHandler(people))
	api.Post("/people/merge", PeopleMergeHandler(people))
	api.Post("/people/split", PeopleSplitHandler(people))

	list := peopleHandlerRequest(t, app, fiber.MethodGet, "/api/people", "")
	var listBody struct {
		People []services.PersonGroup `json:"people"`
	}
	decodePeopleBody(t, list, &listBody)
	if len(listBody.People) != 2 {
		t.Fatalf("people groups = %+v, want two groups", listBody.People)
	}
	var repeated *services.PersonGroup
	for index := range listBody.People {
		if listBody.People[index].FaceCount == 2 {
			repeated = &listBody.People[index]
		}
	}
	if repeated == nil {
		t.Fatalf("similar faces were not grouped: %+v", listBody.People)
	}

	mediaPath := "/api/people/" + repeated.ID + "/media"
	media := peopleHandlerRequest(t, app, fiber.MethodGet, mediaPath, "")
	mediaData, err := io.ReadAll(media.Body)
	media.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if media.StatusCode != fiber.StatusOK || strings.Contains(string(mediaData), root) || strings.Contains(string(mediaData), "embedding") {
		t.Fatalf("person media response leaks local data or failed: %s", mediaData)
	}
	var mediaBody struct {
		Page struct {
			Faces []services.PersonFace `json:"faces"`
			Total int                   `json:"total"`
		} `json:"page"`
	}
	if err := json.Unmarshal(mediaData, &mediaBody); err != nil {
		t.Fatal(err)
	}
	if mediaBody.Page.Total != 2 || len(mediaBody.Page.Faces) != 2 {
		t.Fatalf("person media page = %+v", mediaBody.Page)
	}

	nameBody, _ := json.Marshal(map[string]string{"name": "旅行同伴"})
	updated := peopleHandlerRequest(t, app, fiber.MethodPut, "/api/people/"+repeated.ID, string(nameBody))
	if updated.StatusCode != fiber.StatusOK {
		t.Fatalf("rename status = %d", updated.StatusCode)
	}
	updated.Body.Close()

	faceKey := mediaBody.Page.Faces[0].Key
	splitBody, _ := json.Marshal(map[string]any{"personId": repeated.ID, "faceKeys": []string{faceKey}})
	split := peopleHandlerRequest(t, app, fiber.MethodPost, "/api/people/split", string(splitBody))
	var splitResult struct {
		PersonID string `json:"personId"`
	}
	decodePeopleBody(t, split, &splitResult)
	if splitResult.PersonID == "" {
		t.Fatal("split did not return a new person ID")
	}
	mergeBody, _ := json.Marshal(map[string]string{"sourceId": splitResult.PersonID, "targetId": repeated.ID})
	merge := peopleHandlerRequest(t, app, fiber.MethodPost, "/api/people/merge", string(mergeBody))
	if merge.StatusCode != fiber.StatusOK {
		t.Fatalf("merge status = %d", merge.StatusCode)
	}
	merge.Body.Close()

	hideBody, _ := json.Marshal(map[string]bool{"hidden": true})
	hide := peopleHandlerRequest(t, app, fiber.MethodPut, "/api/people/"+repeated.ID, string(hideBody))
	if hide.StatusCode != fiber.StatusOK {
		t.Fatalf("hide status = %d", hide.StatusCode)
	}
	hide.Body.Close()
	visible := peopleHandlerRequest(t, app, fiber.MethodGet, "/api/people", "")
	var visibleBody struct {
		People []services.PersonGroup `json:"people"`
	}
	decodePeopleBody(t, visible, &visibleBody)
	if len(visibleBody.People) != 1 {
		t.Fatalf("hidden group remained visible: %+v", visibleBody.People)
	}

	cleared := peopleHandlerRequest(t, app, fiber.MethodDelete, "/api/people", "")
	if cleared.StatusCode != fiber.StatusOK || jobs.PeopleEnabled() || len(jobs.Records(services.AIJobTypeFace)) != 0 || len(people.AllFaces()) != 0 {
		t.Fatalf("clear did not remove face data and opt-in: status=%d enabled=%v records=%d", cleared.StatusCode, jobs.PeopleEnabled(), len(jobs.Records(services.AIJobTypeFace)))
	}
	cleared.Body.Close()
}

func peopleHandlerRequest(t *testing.T, app *fiber.App, method, path, body string) *http.Response {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	}
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func decodePeopleBody(t *testing.T, response *http.Response, target any) {
	t.Helper()
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusOK {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("people API status = %d: %s", response.StatusCode, data)
	}
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatal(err)
	}
}
