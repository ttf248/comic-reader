package handlers

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/tianlongxiang/local-gallery/internal/httputil"
	"github.com/tianlongxiang/local-gallery/internal/services"
	"github.com/tianlongxiang/local-gallery/internal/store"
)

// ChinaLocationsHandler 返回全国省级照片统计。
func ChinaLocationsHandler(catalog *services.ResourceCatalog, jobs *services.AIJobService, locations *services.ChinaLocationService, validate func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if jobs == nil || locations == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		timeRange, ok := parseChinaTimeRange(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		revision := jobs.RecordsRevision()
		etag := chinaLocationETag("", services.ChinaLocationBoundaryHash(), snapshot.Revision(), revision, timeRange)
		if matchETag(c.Get(fiber.HeaderIfNoneMatch), etag) {
			return c.SendStatus(fiber.StatusNotModified)
		}
		summary, err := locations.Summary(snapshot, jobs.Records(services.AIJobTypeMetadata), revision, validate, timeRange)
		if err != nil {
			if errors.Is(err, services.ErrLibraryNotReady) {
				return writeLibraryPageError(c, err, snapshot.Revision())
			}
			return writeError(c, fiber.StatusInternalServerError, "location_map_unavailable", "offline location boundaries are unavailable")
		}
		c.Set(fiber.HeaderETag, etag)
		return c.JSON(fiber.Map{"ok": true, "locations": summary})
	}
}

// ChinaLocationRegionsHandler 返回某个区域的下一级区域统计。
func ChinaLocationRegionsHandler(catalog *services.ResourceCatalog, jobs *services.AIJobService, locations *services.ChinaLocationService, validate func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if jobs == nil || locations == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		adcode, err := parseChinaRegionAdcode(c.Params("adcode"))
		if err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_region_adcode", "region adcode must be six digits")
		}
		timeRange, ok := parseChinaTimeRange(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		revision := jobs.RecordsRevision()
		etag := chinaLocationETag(strconv.Itoa(adcode), services.ChinaLocationBoundaryHash(), snapshot.Revision(), revision, timeRange)
		if matchETag(c.Get(fiber.HeaderIfNoneMatch), etag) {
			return c.SendStatus(fiber.StatusNotModified)
		}
		regions, err := locations.Regions(snapshot, jobs.Records(services.AIJobTypeMetadata), revision, validate, adcode, timeRange)
		if err != nil {
			if errors.Is(err, services.ErrChinaRegionNotFound) {
				return writeError(c, fiber.StatusNotFound, "region_not_found", "region was not found in the offline boundaries")
			}
			if errors.Is(err, services.ErrLibraryNotReady) {
				return writeLibraryPageError(c, err, snapshot.Revision())
			}
			return writeError(c, fiber.StatusInternalServerError, "location_map_unavailable", "offline location boundaries are unavailable")
		}
		c.Set(fiber.HeaderETag, etag)
		return c.JSON(fiber.Map{"ok": true, "regions": regions})
	}
}

// ChinaLocationRegionVisitsHandler 返回某个区域的到访记录。
func ChinaLocationRegionVisitsHandler(catalog *services.ResourceCatalog, jobs *services.AIJobService, locations *services.ChinaLocationService, validate func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if jobs == nil || locations == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		adcode, err := parseChinaRegionAdcode(c.Params("adcode"))
		if err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_region_adcode", "region adcode must be six digits")
		}
		timeRange, ok := parseChinaTimeRange(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		visits, err := locations.Visits(snapshot, jobs.Records(services.AIJobTypeMetadata), jobs.RecordsRevision(), validate, adcode, timeRange)
		if err != nil {
			if errors.Is(err, services.ErrChinaRegionNotFound) {
				return writeError(c, fiber.StatusNotFound, "region_not_found", "region was not found in the offline boundaries")
			}
			if errors.Is(err, services.ErrLibraryNotReady) {
				return writeLibraryPageError(c, err, snapshot.Revision())
			}
			return writeError(c, fiber.StatusInternalServerError, "location_map_unavailable", "offline location boundaries are unavailable")
		}
		return c.JSON(fiber.Map{"ok": true, "visits": visits})
	}
}

// ChinaLocationRegionMediaHandler 返回某个区域的照片墙分页。
func ChinaLocationRegionMediaHandler(catalog *services.ResourceCatalog, jobs *services.AIJobService, locations *services.ChinaLocationService, validate func(string) (string, error), picks *store.PickStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if jobs == nil || locations == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		adcode, err := parseChinaRegionAdcode(c.Params("adcode"))
		if err != nil {
			return writeError(c, fiber.StatusBadRequest, "invalid_region_adcode", "region adcode must be six digits")
		}
		timeRange, ok := parseChinaTimeRange(c)
		if !ok {
			return nil
		}
		visit, ok := parseChinaVisitIndex(c)
		if !ok {
			return nil
		}
		limit, ok := parseLibraryPageLimit(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		page, err := locations.RegionMedia(snapshot, jobs.Records(services.AIJobTypeMetadata), jobs.RecordsRevision(), validate, adcode, timeRange, visit, c.Query("cursor"), limit)
		if err != nil {
			if errors.Is(err, services.ErrChinaRegionNotFound) {
				return writeError(c, fiber.StatusNotFound, "region_not_found", "region was not found in the offline boundaries")
			}
			if errors.Is(err, services.ErrChinaVisitNotFound) {
				return writeError(c, fiber.StatusNotFound, "region_visit_not_found", "region visit was not found")
			}
			return writeLibraryPageError(c, err, snapshot.Revision())
		}
		markFeedPicks(picks, page.Items)
		return c.JSON(fiber.Map{"ok": true, "page": page})
	}
}

// ChinaPlacesHandler 返回地点索引：去过哪些地方。
func ChinaPlacesHandler(catalog *services.ResourceCatalog, jobs *services.AIJobService, locations *services.ChinaLocationService, validate func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if jobs == nil || locations == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		level := strings.TrimSpace(c.Query("level"))
		if level == "" {
			level = services.ChinaProvinceLevel
		}
		if !services.IsChinaPlaceGranularity(level) {
			return writeError(c, fiber.StatusBadRequest, "invalid_region_level", "level must be province, city or district")
		}
		parent := 0
		if raw := strings.TrimSpace(c.Query("parent")); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value <= 0 {
				return writeError(c, fiber.StatusBadRequest, "invalid_region_adcode", "parent adcode must be a positive integer")
			}
			parent = value
		}
		timeRange, ok := parseChinaTimeRange(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		revision := jobs.RecordsRevision()
		etag := chinaLocationETag("places-"+level+"-"+strconv.Itoa(parent), services.ChinaLocationBoundaryHash(), snapshot.Revision(), revision, timeRange)
		if matchETag(c.Get(fiber.HeaderIfNoneMatch), etag) {
			return c.SendStatus(fiber.StatusNotModified)
		}
		places, err := locations.Places(snapshot, jobs.Records(services.AIJobTypeMetadata), revision, validate, level, parent, timeRange)
		if err != nil {
			if errors.Is(err, services.ErrChinaRegionNotFound) {
				return writeError(c, fiber.StatusNotFound, "region_not_found", "region was not found in the offline boundaries")
			}
			if errors.Is(err, services.ErrLibraryNotReady) {
				return writeLibraryPageError(c, err, snapshot.Revision())
			}
			return writeError(c, fiber.StatusInternalServerError, "location_map_unavailable", "offline location boundaries are unavailable")
		}
		c.Set(fiber.HeaderETag, etag)
		return c.JSON(fiber.Map{"ok": true, "places": places})
	}
}

// ChinaTripsHandler 返回行程与停留：什么时候去了哪些地方。
func ChinaTripsHandler(catalog *services.ResourceCatalog, jobs *services.AIJobService, locations *services.ChinaLocationService, validate func(string) (string, error)) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if jobs == nil || locations == nil {
			return writeError(c, fiber.StatusServiceUnavailable, "analysis_unavailable", "analysis service is unavailable")
		}
		granularity := strings.TrimSpace(c.Query("granularity"))
		if granularity == "" {
			granularity = services.ChinaCityLevel
		}
		if !services.IsChinaPlaceGranularity(granularity) {
			return writeError(c, fiber.StatusBadRequest, "invalid_region_level", "granularity must be province, city or district")
		}
		timeRange, ok := parseChinaTimeRange(c)
		if !ok {
			return nil
		}
		snapshot := requestCatalogSnapshot(c, catalog)
		revision := jobs.RecordsRevision()
		etag := chinaLocationETag("trips-"+granularity, services.ChinaLocationBoundaryHash(), snapshot.Revision(), revision, timeRange)
		if matchETag(c.Get(fiber.HeaderIfNoneMatch), etag) {
			return c.SendStatus(fiber.StatusNotModified)
		}
		trips, err := locations.Trips(snapshot, jobs.Records(services.AIJobTypeMetadata), revision, validate, granularity, timeRange)
		if err != nil {
			if errors.Is(err, services.ErrLibraryNotReady) {
				return writeLibraryPageError(c, err, snapshot.Revision())
			}
			return writeError(c, fiber.StatusInternalServerError, "location_map_unavailable", "offline location boundaries are unavailable")
		}
		c.Set(fiber.HeaderETag, etag)
		return c.JSON(fiber.Map{"ok": true, "trips": trips})
	}
}

// ChinaGeometryHandler 返回绘图用的行政区轮廓。
//
// 这个端点与媒体库无关：轮廓是静态数据，只随边界数据变化。因此它
// 不带媒体库版本、可以长期缓存，也不触发匹配索引的加载（那要 6 秒）。
//
// 响应只含当前视图需要的层级：全国取省，进入省取该省的市，进入市取
// 该市的区县。整份轮廓下发是 5MB，按需取用才是几十到几百 KB。
func ChinaGeometryHandler() fiber.Handler {
	return func(c *fiber.Ctx) error {
		level := strings.TrimSpace(c.Params("level"))
		parent := 0
		if raw := strings.TrimSpace(c.Query("parent")); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value <= 0 {
				return writeError(c, fiber.StatusBadRequest, "invalid_region_adcode", "parent adcode must be a positive integer")
			}
			parent = value
		}
		features, hash, err := services.ChinaOutline(level, parent)
		if err != nil {
			if errors.Is(err, services.ErrChinaRegionNotFound) {
				return writeError(c, fiber.StatusNotFound, "region_not_found", "region was not found in the offline boundaries")
			}
			return writeError(c, fiber.StatusBadRequest, "invalid_region_level", "level must be province, city, district or children")
		}
		etag := `W/"china-outline-` + level + "-" + strconv.Itoa(parent) + "-" + hash + `"`
		if matchETag(c.Get(fiber.HeaderIfNoneMatch), etag) {
			return c.SendStatus(fiber.StatusNotModified)
		}
		c.Set(fiber.HeaderETag, etag)
		c.Set(fiber.HeaderCacheControl, "private, max-age=86400")
		return c.JSON(fiber.Map{
			"ok":              true,
			"boundaryVersion": services.ChinaOutlineVersion(),
			"hash":            hash,
			"level":           level,
			"parentAdcode":    parent,
			"features":        features,
		})
	}
}

// parseChinaTimeRange 解析时间区间参数。
//
// 区间按拍摄时间的日历月给："2019-01" 到 "2019-12"，只给一端也可以。
func parseChinaTimeRange(c *fiber.Ctx) (services.ChinaTimeRange, bool) {
	timeRange := services.ChinaTimeRange{
		From: strings.TrimSpace(c.Query("from")),
		To:   strings.TrimSpace(c.Query("to")),
	}
	for _, value := range []string{timeRange.From, timeRange.To} {
		if value == "" {
			continue
		}
		if _, err := time.Parse("2006-01", value); err != nil {
			_ = httputil.BadRequest(c, "invalid_time_range", "time range must be formatted as YYYY-MM")
			return services.ChinaTimeRange{}, false
		}
	}
	if timeRange.From != "" && timeRange.To != "" && timeRange.From > timeRange.To {
		_ = httputil.BadRequest(c, "invalid_time_range", "time range start must not be after its end")
		return services.ChinaTimeRange{}, false
	}
	return timeRange, true
}

// parseChinaVisitIndex 解析到访序号。缺省是 -1，表示不按到访筛选。
func parseChinaVisitIndex(c *fiber.Ctx) (int, bool) {
	raw := strings.TrimSpace(c.Query("visit"))
	if raw == "" {
		return -1, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		_ = httputil.BadRequest(c, "invalid_region_visit", "visit must be a non-negative integer")
		return -1, false
	}
	return value, true
}

// parseChinaRegionAdcode 解析区划码参数。
func parseChinaRegionAdcode(raw string) (int, error) {
	value := strings.TrimSpace(raw)
	if len(value) != 6 {
		return 0, services.ErrInvalidChinaRegionAdcode
	}
	adcode, err := strconv.Atoi(value)
	if err != nil || adcode <= 0 {
		return 0, services.ErrInvalidChinaRegionAdcode
	}
	return adcode, nil
}

// chinaLocationETag 组合边界数据、媒体库与分析结果的版本。
//
// 时间区间也参与：换了区间的响应内容不同，不能共用同一个标识。
func chinaLocationETag(scope, boundaryHash string, catalogRevision, recordsRevision uint64, timeRange services.ChinaTimeRange) string {
	return `W/"china-` + scope + boundaryHash + "-" +
		strconv.FormatUint(catalogRevision, 10) + "-" +
		strconv.FormatUint(recordsRevision, 10) + "-" +
		timeRange.From + "-" + timeRange.To + `"`
}

// matchETag 判断客户端带的 ETag 是否与当前一致。
func matchETag(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		candidate = strings.TrimPrefix(candidate, "W/")
		current := strings.TrimPrefix(etag, "W/")
		if candidate == current {
			return true
		}
	}
	return false
}
