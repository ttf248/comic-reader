package handlers

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"sort"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/models"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

const (
	faceSimilarityThreshold = 0.363
	faceEmbeddingDimension  = 128
)

type storedFace struct {
	Box       []float32 `json:"box"`
	Score     float32   `json:"score"`
	Embedding []float32 `json:"embedding"`
}

type publicFace struct {
	Box   []float32 `json:"box"`
	Score float32   `json:"score"`
}

type faceSearchRequest struct {
	ResourceID string `json:"resourceId"`
	FaceIndex  int    `json:"faceIndex"`
}

type faceSearchHit struct {
	Item       services.FeedMediaItem `json:"item"`
	FaceIndex  int                    `json:"faceIndex"`
	Similarity float64                `json:"similarity"`
}

// ImageAnalysisHandler returns current OCR and face results without exposing private embeddings.
func ImageAnalysisHandler(jobs *services.AIJobService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		resourceID := middleware.ResourceID(c)
		path := middleware.SafePath(c)
		if !models.IsImageFile(path) {
			return writeError(c, fiber.StatusUnsupportedMediaType, "invalid_analysis_resource", "image analysis is available for images only")
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return writeError(c, fiber.StatusNotFound, "resource_not_found", "resource was not found")
		}
		response := fiber.Map{
			"ok": true, "resourceId": resourceID,
			"ocr":  currentImageAnalysis(jobs, services.AIJobTypeOCR, resourceID, info),
			"face": currentImageAnalysis(jobs, services.AIJobTypeFace, resourceID, info),
		}
		return c.JSON(response)
	}
}

func currentImageAnalysis(jobs *services.AIJobService, moduleType, resourceID string, info os.FileInfo) fiber.Map {
	version := services.OCRAnalyzerVersion
	if moduleType == services.AIJobTypeFace {
		version = services.FaceAnalyzerVersion
	}
	record, ok := jobs.Record(moduleType, resourceID)
	if !ok || record.ModuleVersion != version || record.Size != info.Size() || record.MTimeNs != info.ModTime().UnixNano() {
		return fiber.Map{"status": "pending"}
	}
	if record.Status == "failed" {
		return fiber.Map{"status": record.Status, "updatedAt": record.UpdatedAt, "error": fiber.Map{"code": record.ErrorCode, "message": record.ErrorMessage}}
	}
	if moduleType == services.AIJobTypeOCR {
		var result struct {
			Text  string `json:"text"`
			Lines []struct {
				Text       string      `json:"text"`
				Confidence float64     `json:"confidence"`
				Box        [][]float64 `json:"box"`
			} `json:"lines"`
		}
		if json.Unmarshal(record.Data, &result) != nil {
			return fiber.Map{"status": "failed", "error": fiber.Map{"code": "analysis_result_invalid", "message": "识别结果不可用"}}
		}
		return fiber.Map{"status": record.Status, "updatedAt": record.UpdatedAt, "text": result.Text, "lines": result.Lines}
	}
	var result struct {
		Faces []publicFace `json:"faces"`
	}
	if json.Unmarshal(record.Data, &result) != nil {
		return fiber.Map{"status": "failed", "error": fiber.Map{"code": "analysis_result_invalid", "message": "识别结果不可用"}}
	}
	return fiber.Map{"status": record.Status, "updatedAt": record.UpdatedAt, "faces": result.Faces}
}

// FaceSimilaritySearchHandler finds current photos with SFace embeddings similar to a selected face.
func FaceSimilaritySearchHandler(
	jobs *services.AIJobService,
	catalog *services.ResourceCatalog,
	validatePath func(string) (string, error),
) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var request faceSearchRequest
		if err := c.BodyParser(&request); err != nil || request.ResourceID == "" || request.FaceIndex < 0 || request.FaceIndex > 100 {
			return writeError(c, fiber.StatusBadRequest, "invalid_face_search", "resourceId and faceIndex are invalid")
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		source, err := currentFaceRecord(jobs, snapshot, request.ResourceID, validatePath)
		if err != nil {
			return writeError(c, fiber.StatusNotFound, "face_search_source_unavailable", "source face analysis is unavailable")
		}
		var sourceData struct {
			Faces []storedFace `json:"faces"`
		}
		if json.Unmarshal(source.Data, &sourceData) != nil || request.FaceIndex >= len(sourceData.Faces) || len(sourceData.Faces[request.FaceIndex].Embedding) != faceEmbeddingDimension {
			return writeError(c, fiber.StatusBadRequest, "invalid_face_search", "selected face is unavailable")
		}
		query := sourceData.Faces[request.FaceIndex].Embedding
		type candidate struct {
			item  services.FeedMediaItem
			index int
			score float64
		}
		bestByResource := make(map[string]candidate)
		for _, record := range jobs.Records(services.AIJobTypeFace) {
			if record.ResourceID == request.ResourceID || record.Status != "faces_found" || record.ModuleVersion != services.FaceAnalyzerVersion {
				continue
			}
			item, exists := services.LookupLibraryFeedItem(snapshot, record.ResourceID)
			if !exists || item.Kind != "image" {
				continue
			}
			album, exists := snapshot.LibraryNode(item.AlbumID)
			if !exists || album.ContentKind != "photo" {
				continue
			}
			_, pathErr := currentFaceRecord(jobs, snapshot, record.ResourceID, validatePath)
			if pathErr != nil {
				continue
			}
			var data struct {
				Faces []storedFace `json:"faces"`
			}
			if json.Unmarshal(record.Data, &data) != nil {
				continue
			}
			for index, face := range data.Faces {
				score := normalizedCosine(query, face.Embedding)
				if score < faceSimilarityThreshold {
					continue
				}
				previous, found := bestByResource[record.ResourceID]
				if !found || score > previous.score {
					bestByResource[record.ResourceID] = candidate{item: item, index: index, score: score}
				}
			}
		}
		hits := make([]candidate, 0, len(bestByResource))
		for _, hit := range bestByResource {
			hits = append(hits, hit)
		}
		sort.Slice(hits, func(i, j int) bool {
			if hits[i].score == hits[j].score {
				return hits[i].item.ID < hits[j].item.ID
			}
			return hits[i].score > hits[j].score
		})
		if len(hits) > 40 {
			hits = hits[:40]
		}
		results := make([]faceSearchHit, 0, len(hits))
		for _, hit := range hits {
			results = append(results, faceSearchHit{Item: hit.item, FaceIndex: hit.index, Similarity: hit.score})
		}
		return c.JSON(fiber.Map{"ok": true, "threshold": faceSimilarityThreshold, "results": results, "total": len(bestByResource), "revision": snapshot.Revision()})
	}
}

func currentFaceRecord(
	jobs *services.AIJobService,
	snapshot services.CatalogSnapshot,
	resourceID string,
	validatePath func(string) (string, error),
) (services.AIAnalysisRecord, error) {
	record, ok := jobs.Record(services.AIJobTypeFace, resourceID)
	if !ok || record.Status != "faces_found" || record.ModuleVersion != services.FaceAnalyzerVersion {
		return services.AIAnalysisRecord{}, errors.New("face record unavailable")
	}
	ref, ok := snapshot.Lookup(resourceID)
	if !ok || ref.Kind != services.ResourceFile || !models.IsImageFile(ref.AbsolutePath) {
		return services.AIAnalysisRecord{}, errors.New("face resource unavailable")
	}
	path, err := validatePath(ref.AbsolutePath)
	if err != nil {
		return services.AIAnalysisRecord{}, err
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != record.Size || info.ModTime().UnixNano() != record.MTimeNs {
		return services.AIAnalysisRecord{}, errors.New("face resource changed")
	}
	return record, nil
}

func normalizedCosine(left, right []float32) float64 {
	if len(left) != faceEmbeddingDimension || len(right) != faceEmbeddingDimension {
		return -1
	}
	var dot, leftNorm, rightNorm float64
	for index := range left {
		a, b := float64(left[index]), float64(right[index])
		dot += a * b
		leftNorm += a * a
		rightNorm += b * b
	}
	if leftNorm == 0 || rightNorm == 0 || math.IsNaN(dot) || math.IsInf(dot, 0) {
		return -1
	}
	score := dot / math.Sqrt(leftNorm*rightNorm)
	return math.Max(-1, math.Min(1, score))
}
