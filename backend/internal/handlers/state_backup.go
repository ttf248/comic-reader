package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	"github.com/gofiber/fiber/v2"
	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

type stateImportInput struct {
	Backup          services.StateBackup `json:"backup"`
	Categories      []string             `json:"categories,omitempty"`
	Versions        map[string]string    `json:"versions,omitempty"`
	LibraryRevision uint64               `json:"libraryRevision,omitempty"`
}

func stateBackupError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, services.ErrBackupTooLarge):
		return httputil.Error(c, 413, "state_backup_too_large", "state backup exceeds import limit")
	case errors.Is(err, services.ErrBackupHistoryLimit):
		return httputil.BadRequest(c, "history_limit_conflict", "select matching history and preferences to preserve all records")
	case errors.Is(err, services.ErrInvalidBackup):
		return httputil.BadRequest(c, "invalid_state_backup", "backup format or selection is invalid")
	case errors.Is(err, store.ErrStateChanged):
		return httputil.Error(c, 409, "state_changed", "state changed; preview again")
	case errors.Is(err, services.ErrLibraryNotReady):
		return httputil.Error(c, 409, "library_not_ready", "scan the current library and preview again")
	default:
		return httputil.Internal(c, "state_backup_failed", "unable to read or persist state backup")
	}
}
func parseStateImport(c *fiber.Ctx) (stateImportInput, error) {
	var input stateImportInput
	if len(c.Body()) > 34*1024*1024 {
		return input, services.ErrBackupTooLarge
	}
	decoder := json.NewDecoder(bytes.NewReader(c.Body()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, services.ErrInvalidBackup
	}
	if err := decoder.Decode(new(interface{})); err != io.EOF {
		return input, services.ErrInvalidBackup
	}
	return input, nil
}
func StateExportHandler(service *services.StateBackupService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		backup, err := service.Export()
		if err != nil {
			return stateBackupError(c, err)
		}
		c.Set(fiber.HeaderCacheControl, "no-store")
		c.Set(fiber.HeaderContentDisposition, `attachment; filename="local-gallery-state.json"`)
		return c.JSON(backup)
	}
}
func StatePreviewHandler(service *services.StateBackupService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		input, err := parseStateImport(c)
		if err != nil {
			return stateBackupError(c, err)
		}
		preview, err := service.Preview(input.Backup)
		if err != nil {
			return stateBackupError(c, err)
		}
		c.Set(fiber.HeaderCacheControl, "no-store")
		return c.JSON(preview)
	}
}
func StateImportHandler(service *services.StateBackupService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		input, err := parseStateImport(c)
		if err != nil {
			return stateBackupError(c, err)
		}
		result, err := service.Restore(input.Backup, input.Categories, input.Versions, input.LibraryRevision)
		if err != nil {
			return stateBackupError(c, err)
		}
		c.Set(fiber.HeaderCacheControl, "no-store")
		return c.JSON(result)
	}
}
