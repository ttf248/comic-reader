package handlers

import (
	"errors"
	"sort"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

type personMediaPage struct {
	Revision   uint64                   `json:"revision"`
	Person     services.PersonGroup     `json:"person"`
	Items      []services.FeedMediaItem `json:"items"`
	Faces      []services.PersonFace    `json:"faces"`
	Total      int                      `json:"total"`
	NextCursor string                   `json:"nextCursor,omitempty"`
}

const peopleListLimit = 50
const peopleSearchLimit = 20

// PeopleHandler lists current photo-only person albums and clears all face-derived data.
func PeopleHandler(people *services.PeopleService, jobs *services.AIJobService, catalog *services.ResourceCatalog, validatePath func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if c.Method() == fiber.MethodDelete {
			if _, err := jobs.SetPeopleEnabled(false); err != nil {
				if errors.Is(err, services.ErrAIJobActive) {
					return writeError(c, fiber.StatusConflict, "analysis_job_active", "stop face analysis before clearing people data")
				}
				return writeError(c, fiber.StatusInternalServerError, "people_clear_failed", "people analysis could not be disabled")
			}
			if err := jobs.ClearModuleRecords(services.AIJobTypeFace); err != nil {
				return writeError(c, fiber.StatusInternalServerError, "people_clear_failed", "face analysis data could not be cleared")
			}
			if err := people.Clear(); err != nil {
				return writeError(c, fiber.StatusInternalServerError, "people_clear_failed", "people corrections could not be cleared")
			}
			return c.JSON(fiber.Map{"ok": true, "cleared": true, "peopleEnabled": false})
		}
		query := strings.TrimSpace(c.Query("q"))
		limit := peopleListLimit
		if query != "" {
			if len([]rune(query)) < 2 {
				return writeError(c, fiber.StatusBadRequest, "invalid_people_query", "search with at least two characters")
			}
			limit = peopleSearchLimit
			if rawLimit := strings.TrimSpace(c.Query("limit")); rawLimit != "" {
				parsed, err := strconv.Atoi(rawLimit)
				if err != nil || parsed < 1 || parsed > 50 {
					return writeError(c, fiber.StatusBadRequest, "invalid_people_limit", "limit must be between 1 and 50")
				}
				limit = parsed
			}
		} else if rawLimit := strings.TrimSpace(c.Query("limit")); rawLimit != "" {
			parsed, err := strconv.Atoi(rawLimit)
			if err != nil || parsed < 1 || parsed > peopleListLimit {
				return writeError(c, fiber.StatusBadRequest, "invalid_people_limit", "limit must be between 1 and 50")
			}
			limit = parsed
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		if !snapshot.Ready() {
			return c.JSON(fiber.Map{
				"ok": true, "people": []services.PersonGroup{}, "totalGroups": 0,
				"limit": limit, "centroidThreshold": services.PeopleGroupingCentroidThreshold,
				"exemplarThreshold":        services.PeopleGroupingExemplarThreshold,
				"ambiguousFaceThreshold":   services.PeopleGroupingAmbiguousFaceThreshold,
				"imageSimilarityThreshold": services.PeopleGroupingImageThreshold,
				"revision":                 snapshot.Revision(),
			})
		}
		groups, total := people.SearchGroups(query, limit, c.Query("includeHidden") == "true", snapshot.IsPhotoImage)
		return c.JSON(fiber.Map{
			"ok": true, "people": groups, "totalGroups": total, "limit": limit,
			"centroidThreshold":        services.PeopleGroupingCentroidThreshold,
			"exemplarThreshold":        services.PeopleGroupingExemplarThreshold,
			"ambiguousFaceThreshold":   services.PeopleGroupingAmbiguousFaceThreshold,
			"imageSimilarityThreshold": services.PeopleGroupingImageThreshold,
			"revision":                 snapshot.Revision(),
		})
	}
}

// PersonMediaHandler returns a paged photo-wall feed for one current person group.
func PersonMediaHandler(people *services.PeopleService, jobs *services.AIJobService, catalog *services.ResourceCatalog, dimensions *services.MediaDimensionService, validatePath func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		personID := c.Params("id")
		selected, faces, exists := people.GroupAndFaces(personID)
		if !exists {
			return writeError(c, fiber.StatusNotFound, "person_not_found", "person group was not found")
		}
		unique := map[string]struct{}{}
		items := make([]services.FeedMediaItem, 0)
		facesByResource := map[string][]services.PersonFace{}
		for _, face := range faces {
			facesByResource[face.ResourceID] = append(facesByResource[face.ResourceID], face)
			if _, exists := unique[face.ResourceID]; exists {
				continue
			}
			item, exists := services.LookupLibraryFeedItem(snapshot, face.ResourceID)
			if !exists || item.Kind != "image" {
				continue
			}
			album, exists := snapshot.LibraryNode(item.AlbumID)
			if !exists || album.ContentKind != "photo" {
				continue
			}
			unique[face.ResourceID] = struct{}{}
			items = append(items, item)
		}
		sort.Slice(items, func(i, j int) bool {
			if items[i].AlbumID == items[j].AlbumID {
				return items[i].Index < items[j].Index
			}
			return items[i].AlbumID < items[j].AlbumID
		})
		scope := "people:" + personID
		offset := 0
		var err error
		if cursor := c.Query("cursor"); cursor != "" {
			offset, err = services.DecodePageCursor(cursor, snapshot.Revision(), scope)
			if err != nil {
				return writeLibraryPageError(c, err, snapshot.Revision())
			}
		}
		start := min(offset, len(items))
		end := min(start+limit, len(items))
		var next string
		if end < len(items) {
			next, err = services.EncodePageCursor(snapshot.Revision(), scope, end)
			if err != nil {
				return writeError(c, fiber.StatusInternalServerError, "page_cursor_unavailable", "person album page could not be created")
			}
		}
		pageItems := make([]services.FeedMediaItem, 0, end-start)
		pageFaces := make([]services.PersonFace, 0)
		for _, item := range items[start:end] {
			if _, err := currentFaceRecord(jobs, snapshot, item.ID, validatePath); err != nil {
				continue
			}
			pageItems = append(pageItems, item)
			pageFaces = append(pageFaces, facesByResource[item.ID]...)
			if len(pageFaces) >= 500 {
				pageFaces = pageFaces[:500]
				break
			}
		}
		for i := range pageItems {
			enrichMediaDimension(snapshot, &pageItems[i].LibraryMediaItem, dimensions)
		}
		if dimensions != nil {
			dimensions.Flush()
		}
		page := personMediaPage{Revision: snapshot.Revision(), Person: selected, Items: pageItems, Faces: pageFaces, Total: len(items), NextCursor: next}
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// PersonHandler renames or hides an automatically grouped candidate person.
func PersonHandler(people *services.PeopleService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var body struct {
			Name   *string `json:"name"`
			Hidden *bool   `json:"hidden"`
		}
		if err := c.BodyParser(&body); err != nil || body.Name == nil && body.Hidden == nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_person_change", "provide a name or hidden value")
		}
		if body.Name != nil {
			if err := people.Rename(c.Params("id"), *body.Name); err != nil {
				return personChangeError(c, err)
			}
		}
		if body.Hidden != nil {
			if err := people.SetHidden(c.Params("id"), *body.Hidden); err != nil {
				return personChangeError(c, err)
			}
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

func PeopleMergeHandler(people *services.PeopleService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var body struct {
			SourceID string `json:"sourceId"`
			TargetID string `json:"targetId"`
		}
		if err := c.BodyParser(&body); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_person_change", "sourceId and targetId are required")
		}
		if err := people.Merge(body.SourceID, body.TargetID); err != nil {
			return personChangeError(c, err)
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

func PeopleSplitHandler(people *services.PeopleService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var body struct {
			PersonID string   `json:"personId"`
			FaceKeys []string `json:"faceKeys"`
		}
		if err := c.BodyParser(&body); err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_person_change", "personId and faceKeys are required")
		}
		personID, err := people.Split(body.PersonID, body.FaceKeys)
		if err != nil {
			return personChangeError(c, err)
		}
		return c.JSON(fiber.Map{"ok": true, "personId": personID})
	}
}

func personChangeError(c *fiber.Ctx, err error) error {
	if errors.Is(err, services.ErrPersonNotFound) {
		return writeError(c, fiber.StatusNotFound, "person_not_found", "person group was not found")
	}
	if errors.Is(err, services.ErrInvalidPerson) {
		return writeError(c, fiber.StatusBadRequest, "invalid_person_change", "person correction is invalid")
	}
	return writeError(c, fiber.StatusInternalServerError, "person_change_failed", "person correction could not be saved")
}
