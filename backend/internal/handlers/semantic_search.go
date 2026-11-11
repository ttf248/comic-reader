package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

type semanticSearchRequest struct {
	Text       string `json:"text"`
	ResourceID string `json:"resourceId"`
	Kind       string `json:"kind"`
	AlbumID    string `json:"albumId"`
	Year       string `json:"year"`
	LocationID string `json:"locationId"`
	Offset     int    `json:"offset"`
	Limit      int    `json:"limit"`
}

type semanticSearchHit struct {
	Item       services.FeedMediaItem `json:"item"`
	Similarity float64                `json:"similarity"`
}

// AIEmbeddingStatusHandler 返回本机运行时、GPU、权重和向量覆盖状态。
func AIEmbeddingStatusHandler(analyzer *services.EmbeddingAnalyzer, jobs *services.AIJobService, catalog *services.ResourceCatalog) fiber.Handler {
	return func(c *fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		status, err := analyzer.Status(ctx)
		if err != nil {
			return writeError(c, fiber.StatusServiceUnavailable, "ai_runtime_unavailable", "local AI runtime status is unavailable")
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		status.Coverage = services.AIIndexCoverage{Indexed: 0, Total: 0}
		indexed := make(map[string]services.AIAnalysisRecord)
		for _, record := range jobs.Records(services.AIJobTypeEmbedding) {
			if analyzer.RecordCurrent(record) {
				indexed[record.ResourceID] = record
			}
		}
		if snapshot.Ready() {
			for _, id := range snapshot.FileIDs() {
				ref, ok := snapshot.Lookup(id)
				if !ok || !models.IsImageFile(ref.AbsolutePath) {
					continue
				}
				status.Coverage.Total++
				if _, ok := indexed[id]; ok {
					status.Coverage.Indexed++
				}
			}
		}
		return c.JSON(fiber.Map{"ok": true, "status": status})
	}
}

// SemanticSearchHandler 用文本或媒体库图片进行本地向量检索。
// 图片查询既可传当前资源 ID，也可用 multipart 上传一张临时查询图。
func SemanticSearchHandler(
	analyzer *services.EmbeddingAnalyzer,
	jobs *services.AIJobService,
	catalog *services.ResourceCatalog,
	validatePath func(string) (string, error),
	tempDir string,
) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var request semanticSearchRequest
		var uploadedPath string
		if strings.HasPrefix(strings.ToLower(c.Get(fiber.HeaderContentType)), "multipart/form-data") {
			request = semanticSearchRequest{
				Text: c.FormValue("text"), ResourceID: c.FormValue("resourceId"),
				Kind: c.FormValue("kind"), AlbumID: c.FormValue("albumId"),
				Year: c.FormValue("year"), LocationID: c.FormValue("locationId"),
				Offset: parseSemanticInt(c.FormValue("offset"), 0), Limit: parseSemanticInt(c.FormValue("limit"), 60),
			}
			file, err := c.FormFile("image")
			if err == nil {
				source, openErr := file.Open()
				if openErr != nil {
					return writeError(c, fiber.StatusBadRequest, "invalid_query_image", "query image could not be read")
				}
				defer source.Close()
				temporary, createErr := os.CreateTemp(tempDir, "semantic-query-*.image")
				if createErr != nil {
					return writeError(c, fiber.StatusInternalServerError, "query_image_unavailable", "query image could not be prepared")
				}
				uploadedPath = temporary.Name()
				defer os.Remove(uploadedPath)
				written, copyErr := io.Copy(temporary, io.LimitReader(source, 64*1024*1024+1))
				closeErr := temporary.Close()
				if copyErr != nil || closeErr != nil || written > 64*1024*1024 {
					return writeError(c, fiber.StatusBadRequest, "invalid_query_image", "query image exceeds the 64 MiB limit")
				}
			}
		} else if err := c.BodyParser(&request); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_semantic_search", "request body is not valid JSON")
		}
		request.Text = strings.TrimSpace(request.Text)
		if len(request.Text) > 512 {
			return writeError(c, fiber.StatusBadRequest, "invalid_semantic_search", "text query must be at most 512 characters")
		}
		if (request.Text == "") == (request.ResourceID == "" && uploadedPath == "") {
			return writeError(c, fiber.StatusBadRequest, "invalid_semantic_search", "provide either text or one image query")
		}
		if request.ResourceID != "" && uploadedPath != "" {
			return writeError(c, fiber.StatusBadRequest, "invalid_semantic_search", "provide only one image query")
		}
		kind := services.LibraryKindScope(request.Kind)
		if kind != services.LibraryKindPhoto && kind != services.LibraryKindComic {
			return writeError(c, fiber.StatusBadRequest, "invalid_library_kind", "kind must be photo or comic")
		}
		if request.Year != "" {
			if len(request.Year) != 4 {
				return writeError(c, fiber.StatusBadRequest, "invalid_semantic_filter", "year must contain four digits")
			}
			if _, err := strconv.Atoi(request.Year); err != nil {
				return writeError(c, fiber.StatusBadRequest, "invalid_semantic_filter", "year must contain four digits")
			}
		}
		if request.Offset < 0 || request.Offset > 10000 {
			request.Offset = 0
		}
		if request.Limit <= 0 || request.Limit > 200 {
			request.Limit = 60
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		if !snapshot.Ready() {
			return c.JSON(fiber.Map{"ok": true, "results": []semanticSearchHit{}, "total": 0, "nextOffset": 0, "revision": snapshot.Revision()})
		}

		queryVector, err := semanticQueryVector(analyzer, request, uploadedPath, snapshot, validatePath)
		if err != nil {
			return semanticSearchError(c, err)
		}
		embeddingRecords := make(map[string]services.AIAnalysisRecord)
		for _, record := range jobs.Records(services.AIJobTypeEmbedding) {
			embeddingRecords[record.ResourceID] = record
		}
		metadataRecords := make(map[string]services.AIAnalysisRecord)
		if request.Year != "" || request.LocationID != "" {
			for _, record := range jobs.Records(services.AIJobTypeMetadata) {
				metadataRecords[record.ResourceID] = record
			}
		}
		candidates := make([]services.VectorMetadata, 0, len(embeddingRecords))
		candidateByID := make(map[string]services.VectorMetadata, len(embeddingRecords))
		for _, metadata := range analyzer.Index().Metadata() {
			record, exists := embeddingRecords[metadata.ResourceID]
			if !exists || !analyzer.RecordCurrent(record) || record.Size != metadata.Size || record.MTimeNs != metadata.MTimeNs {
				continue
			}
			ref, exists := snapshot.Lookup(metadata.ResourceID)
			if !exists || ref.Kind != services.ResourceFile || !models.IsImageFile(ref.AbsolutePath) {
				continue
			}
			item, exists := services.LookupLibraryFeedItem(snapshot, metadata.ResourceID)
			if !exists || item.Kind != "image" {
				continue
			}
			album, exists := snapshot.LibraryNode(item.AlbumID)
			if !exists || album.ContentKind != string(kind) || request.AlbumID != "" && request.AlbumID != item.AlbumID {
				continue
			}
			if request.Year != "" || request.LocationID != "" {
				metaRecord, exists := metadataRecords[metadata.ResourceID]
				if !exists || metaRecord.Status != services.MetadataParseParsed || metaRecord.Size != metadata.Size || metaRecord.MTimeNs != metadata.MTimeNs {
					continue
				}
				var imageMetadata services.ImageMetadata
				if json.Unmarshal(metaRecord.Data, &imageMetadata) != nil {
					continue
				}
				if request.Year != "" && !strings.HasPrefix(imageMetadata.DateTimeOriginal, request.Year) {
					continue
				}
				if request.LocationID != "" && (imageMetadata.GPS == nil || services.GPSLocationID(imageMetadata.GPS.Latitude, imageMetadata.GPS.Longitude) != request.LocationID) {
					continue
				}
			}
			candidates = append(candidates, metadata)
			candidateByID[metadata.ResourceID] = metadata
		}
		start := request.Offset
		if start > len(candidates) {
			start = len(candidates)
		}
		pageHits, total, err := analyzer.Index().Search(queryVector, candidates, start, request.Limit)
		if err != nil {
			return writeError(c, fiber.StatusInternalServerError, "semantic_search_failed", "semantic search failed")
		}
		ids := make([]string, 0, len(pageHits))
		scores := make(map[string]float64, len(pageHits))
		fingerprints := make(map[string]services.VectorMetadata, len(pageHits))
		for _, hit := range pageHits {
			ids = append(ids, hit.ResourceID)
			scores[hit.ResourceID] = hit.Score
			fingerprints[hit.ResourceID] = candidateByID[hit.ResourceID]
		}
		items := services.ResolveLibraryFeedItems(snapshot, ids, validatePath)
		results := make([]semanticSearchHit, 0, len(items))
		for _, item := range items {
			fingerprint := fingerprints[item.ID]
			ref, exists := snapshot.Lookup(item.ID)
			if !exists {
				continue
			}
			path, validateErr := validatePath(ref.AbsolutePath)
			if validateErr != nil {
				continue
			}
			info, statErr := os.Stat(path)
			if statErr != nil || !info.Mode().IsRegular() || info.Size() != fingerprint.Size || info.ModTime().UnixNano() != fingerprint.MTimeNs {
				continue
			}
			results = append(results, semanticSearchHit{Item: item, Similarity: scores[item.ID]})
		}
		nextOffset := start + len(pageHits)
		if nextOffset > total {
			nextOffset = total
		}
		return c.JSON(fiber.Map{
			"ok": true, "results": results, "total": total, "offset": request.Offset,
			"nextOffset": nextOffset, "revision": snapshot.Revision(),
		})
	}
}

func semanticQueryVector(
	analyzer *services.EmbeddingAnalyzer,
	request semanticSearchRequest,
	uploadedPath string,
	snapshot services.CatalogSnapshot,
	validatePath func(string) (string, error),
) ([]float32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if request.Text != "" {
		return analyzer.SearchText(ctx, request.Text)
	}
	path := uploadedPath
	if request.ResourceID != "" {
		ref, exists := snapshot.Lookup(request.ResourceID)
		if !exists || ref.Kind != services.ResourceFile || !models.IsImageFile(ref.AbsolutePath) {
			return nil, errors.New("query_image_not_found")
		}
		validated, err := validatePath(ref.AbsolutePath)
		if err != nil {
			return nil, errors.New("query_image_not_found")
		}
		info, err := os.Stat(validated)
		if err != nil || !info.Mode().IsRegular() {
			return nil, errors.New("query_image_not_found")
		}
		path = validated
	}
	if path == "" {
		return nil, errors.New("query_image_not_found")
	}
	return analyzer.SearchImage(ctx, path)
}

func parseSemanticInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func semanticSearchError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, services.ErrAIModelUnavailable):
		return writeError(c, fiber.StatusServiceUnavailable, "ai_model_missing", "local semantic model is missing or checksum verification failed")
	case errors.Is(err, services.ErrAIRuntimeUnavailable), errors.Is(err, services.ErrAIWorkerUnavailable):
		return writeError(c, fiber.StatusServiceUnavailable, "ai_runtime_unavailable", "local AI runtime is unavailable")
	case errors.Is(err, os.ErrNotExist), strings.Contains(err.Error(), "query_image_not_found"):
		return writeError(c, fiber.StatusNotFound, "query_image_not_found", "query image is not available in the current library")
	default:
		return writeError(c, fiber.StatusInternalServerError, "semantic_search_failed", "semantic search failed")
	}
}
