package handlers

import (
	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/middleware"
	"github.com/tianlongxiang/local-gallery/internal/services"
)

func requestCatalogSnapshot(c *fiber.Ctx, catalog *services.ResourceCatalog) services.CatalogSnapshot {
	if pinned, ok := middleware.ResourceSnapshot(c).(services.CatalogSnapshot); ok {
		return pinned
	}
	if catalog == nil {
		return services.CatalogSnapshot{}
	}
	return catalog.Acquire()
}

func publicID(catalog *services.ResourceCatalog, path string, kind services.ResourceKind) string {
	return catalog.ExternalID(path, kind)
}

func resolveResource(c *fiber.Ctx, catalog *services.ResourceCatalog, id string, kind services.ResourceKind) (string, bool) {
	ref, ok := catalog.Lookup(id)
	if !ok || ref.Kind != kind {
		_ = httputil.BadRequest(c, "invalid_resource_id", "resource id is invalid or has the wrong type")
		return "", false
	}
	return ref.AbsolutePath, true
}
