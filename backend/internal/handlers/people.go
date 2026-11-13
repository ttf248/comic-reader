package handlers

import (
	"errors"
	"sort"

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
		limit := peopleListLimit
		if c.Query("includeAll") == "true" {
			limit = 0
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		if !snapshot.Ready() {
			return c.JSON(fiber.Map{
				"ok": true, "people": []services.PersonGroup{}, "totalGroups": 0,
				"limit": limit, "groupingLimited": false, "revision": snapshot.Revision(),
			})
		}
		groups, total := people.TopGroups(limit, c.Query("includeHidden") == "true", snapshot.IsPhotoImage)
		return c.JSON(fiber.Map{
			"ok": true, "people": groups, "totalGroups": total, "limit": limit,
			"groupingLimited": people.GroupingLimited(), "threshold": 0.363, "revision": snapshot.Revision(),
		})
	}
}

// PersonMediaHandler returns a paged photo-wall feed for one current person group.
func PersonMediaHandler(people *services.PeopleService, jobs *services.AIJobService, catalog *services.ResourceCatalog, validatePath func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		personID := c.Params("id")
		var selected services.PersonGroup
		for _, group := range people.Groups(true) {
			if group.ID == personID {
				selected = group
				break
			}
		}
		if selected.ID == "" {
			return writeError(c, fiber.StatusNotFound, "person_not_found", "person group was not found")
		}
		unique := map[string]struct{}{}
		items := make([]services.FeedMediaItem, 0)
		facesByResource := map[string][]services.PersonFace{}
		for _, face := range people.Faces(personID) {
			facesByResource[face.ResourceID] = append(facesByResource[face.ResourceID], face)
			if _, exists := unique[face.ResourceID]; exists {
				continue
			}
			if _, err := currentFaceRecord(jobs, snapshot, face.ResourceID, validatePath); err != nil {
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
		pageFaces := make([]services.PersonFace, 0)
		for _, item := range items[start:end] {
			pageFaces = append(pageFaces, facesByResource[item.ID]...)
			if len(pageFaces) >= 500 {
				pageFaces = pageFaces[:500]
				break
			}
		}
		page := personMediaPage{Revision: snapshot.Revision(), Person: selected, Items: items[start:end], Faces: pageFaces, Total: len(items), NextCursor: next}
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
