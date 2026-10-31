package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestCacheClearResetsVideoMetadataOnlyForAll(t *testing.T) {
	for _, scope := range []string{"all", "thumbs", "faststart", "transcode", "invalid"} {
		t.Run(scope, func(t *testing.T) {
			cleared := 0
			app := fiber.New()
			app.Post("/api/cache/clear", CacheClearHandler(nil, nil, nil, func() { cleared++ }, nil))
			res, err := app.Test(httptest.NewRequest(http.MethodPost, "/api/cache/clear?scope="+scope, nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if scope == "invalid" {
				if res.StatusCode != http.StatusBadRequest || cleared != 0 {
					t.Fatal("invalid scope cleared metadata")
				}
				return
			}
			var result CacheClearResult
			if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			want := 0
			if scope == "all" {
				want = 1
			}
			if res.StatusCode != http.StatusOK || cleared != want || result.TotalDeleted != 0 || result.TotalFreedBytes != 0 {
				t.Fatalf("status=%d cleared=%d result=%+v", res.StatusCode, cleared, result)
			}
		})
	}
}
