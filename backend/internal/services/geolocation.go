package services

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/tianlongxiang/local-gallery/internal/models"
)

var ErrGPSLocationNotFound = errors.New("GPS location not found")

// GPSLocationAlbum 是由真实 EXIF 坐标聚合出的离线智能相册。
type GPSLocationAlbum struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Latitude        float64 `json:"latitude"`
	Longitude       float64 `json:"longitude"`
	FileCount       int     `json:"fileCount"`
	AlbumCount      int     `json:"albumCount"`
	CoverResourceID string  `json:"coverResourceId,omitempty"`
	CellPrecision   int     `json:"cellPrecision"`
}

type gpsLocationPhoto struct {
	item      FeedMediaItem
	albumRank int
}

type gpsLocationGroup struct {
	GPSLocationAlbum
	latitudeSum  float64
	longitudeSum float64
	photos       []gpsLocationPhoto
	albums       map[string]FeedAlbumRef
}

const gpsLocationGeohashPrecision = 5

// GPSLocationMediaPage 是地点照片分页及该地点的公开摘要。
type GPSLocationMediaPage struct {
	MediaFeedPage
	Location GPSLocationAlbum `json:"location"`
}

// PageGPSLocations 返回当前扫描快照中仍有效、具备真实 GPS 坐标的地点分组。
// 文件路径在每次请求时都按当前媒体根重新校验，旧扫描或旧文件版本会被忽略。
func PageGPSLocations(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	validatePath func(string) (string, error),
	cursor string,
	limit int,
) (LibraryPage[GPSLocationAlbum], error) {
	if !snapshot.Ready() || validatePath == nil {
		return LibraryPage[GPSLocationAlbum]{}, ErrLibraryNotReady
	}
	groups := buildGPSLocationGroups(snapshot, records, validatePath)
	scope := "gps-locations"
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return LibraryPage[GPSLocationAlbum]{}, err
	}
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, len(groups), limit)
	if err != nil {
		return LibraryPage[GPSLocationAlbum]{}, err
	}
	items := make([]GPSLocationAlbum, end-start)
	for index := start; index < end; index++ {
		items[index-start] = groups[index].GPSLocationAlbum
	}
	return LibraryPage[GPSLocationAlbum]{
		Revision: snapshot.Revision(), Items: items, Total: len(groups), NextCursor: next,
	}, nil
}

// PageGPSLocationMedia 返回地点相册的一页照片，并保留来源相册 ID 与名称。
func PageGPSLocationMedia(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	validatePath func(string) (string, error),
	locationID string,
	cursor string,
	limit int,
) (GPSLocationMediaPage, error) {
	if !snapshot.Ready() || validatePath == nil {
		return GPSLocationMediaPage{}, ErrLibraryNotReady
	}
	groups := buildGPSLocationGroups(snapshot, records, validatePath)
	var selected *gpsLocationGroup
	for index := range groups {
		if groups[index].ID == locationID {
			selected = &groups[index]
			break
		}
	}
	if selected == nil {
		return GPSLocationMediaPage{}, ErrGPSLocationNotFound
	}

	scope := "gps-location-media:" + locationID
	offset, err := pageOffset(snapshot, cursor, scope)
	if err != nil {
		return GPSLocationMediaPage{}, err
	}
	start, end, next, err := pageBounds(snapshot.Revision(), scope, cursor != "", offset, len(selected.photos), limit)
	if err != nil {
		return GPSLocationMediaPage{}, err
	}
	items := make([]FeedMediaItem, 0, end-start)
	for _, photo := range selected.photos[start:end] {
		item := photo.item
		if item.sourcePath != "" {
			validatedPath, validationErr := validatePath(item.sourcePath)
			if validationErr != nil {
				continue
			}
			if version, versionErr := MediaVersion(validatedPath); versionErr == nil {
				item.Version = version
			}
		}
		items = append(items, item)
	}
	albumRefs := make([]FeedAlbumRef, 0, len(selected.albums))
	for _, album := range selected.albums {
		albumRefs = append(albumRefs, album)
	}
	sort.Slice(albumRefs, func(i, j int) bool { return albumRefs[i].Name < albumRefs[j].Name })
	return GPSLocationMediaPage{Location: selected.GPSLocationAlbum, MediaFeedPage: MediaFeedPage{
		LibraryPage: LibraryPage[FeedMediaItem]{
			Revision: snapshot.Revision(), Items: items, Total: len(selected.photos), NextCursor: next,
		},
		Albums:  albumRefs,
		Sources: []FeedSource{},
	}}, nil
}

func buildGPSLocationGroups(
	snapshot CatalogSnapshot,
	records []AIAnalysisRecord,
	validatePath func(string) (string, error),
) []gpsLocationGroup {
	if snapshot.state == nil || snapshot.state.library == nil {
		return nil
	}
	groupsByCell := make(map[string]*gpsLocationGroup)
	albumRanks := make(map[string]int, len(snapshot.state.library.albums))
	for index, album := range snapshot.state.library.albums {
		albumRanks[album.ID] = index
	}
	for _, record := range records {
		if record.Type != AIJobTypeMetadata || record.Status != MetadataParseParsed || len(record.Data) == 0 {
			continue
		}
		ref, ok := snapshot.Lookup(record.ResourceID)
		if !ok || ref.Kind != ResourceFile || !models.IsImageFile(ref.AbsolutePath) {
			continue
		}
		path, err := validatePath(ref.AbsolutePath)
		if err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() != record.Size || info.ModTime().UnixNano() != record.MTimeNs {
			continue
		}
		var metadata ImageMetadata
		if json.Unmarshal(record.Data, &metadata) != nil || metadata.GPS == nil {
			continue
		}
		latitude, longitude := metadata.GPS.Latitude, metadata.GPS.Longitude
		if !validCoordinates(latitude, longitude) {
			continue
		}
		cell := encodeGeohash(latitude, longitude, gpsLocationGeohashPrecision)
		group := groupsByCell[cell]
		if group == nil {
			id := gpsLocationID(cell)
			group = &gpsLocationGroup{
				GPSLocationAlbum: GPSLocationAlbum{ID: id, CellPrecision: gpsLocationGeohashPrecision},
				albums:           make(map[string]FeedAlbumRef),
			}
			groupsByCell[cell] = group
		}
		fileRef, exists := snapshot.state.library.mediaByFile[record.ResourceID]
		if !exists {
			continue
		}
		media := snapshot.state.library.media[fileRef.albumID]
		if fileRef.index < 0 || fileRef.index >= len(media) {
			continue
		}
		album, exists := snapshot.state.library.nodes[fileRef.albumID]
		if !exists || album.ContentKind != string(models.ContentKindPhoto) {
			continue
		}
		albumName := strings.TrimSpace(album.DisplayName)
		if albumName == "" {
			albumName = strings.TrimSpace(album.Name)
		}
		item := media[fileRef.index]
		if item.Kind != "image" {
			continue
		}
		group.photos = append(group.photos, gpsLocationPhoto{
			item: FeedMediaItem{
				LibraryMediaItem: item,
				AlbumID:          fileRef.albumID,
				AlbumName:        albumName,
			},
			albumRank: albumRanks[fileRef.albumID],
		})
		group.latitudeSum += latitude
		group.longitudeSum += longitude
		group.FileCount++
		if _, exists := group.albums[fileRef.albumID]; !exists {
			group.albums[fileRef.albumID] = FeedAlbumRef{ID: fileRef.albumID, Name: albumName}
		}
		group.albums[fileRef.albumID] = FeedAlbumRef{
			ID: fileRef.albumID, Name: albumName, Count: group.albums[fileRef.albumID].Count + 1,
		}
	}

	groups := make([]gpsLocationGroup, 0, len(groupsByCell))
	for _, group := range groupsByCell {
		if len(group.photos) == 0 {
			continue
		}
		group.Latitude = group.latitudeSum / float64(group.FileCount)
		group.Longitude = group.longitudeSum / float64(group.FileCount)
		group.Name = fmt.Sprintf("坐标 %.4f°, %.4f°", group.Latitude, group.Longitude)
		group.AlbumCount = len(group.albums)
		sort.SliceStable(group.photos, func(i, j int) bool {
			if group.photos[i].albumRank != group.photos[j].albumRank {
				return group.photos[i].albumRank < group.photos[j].albumRank
			}
			return group.photos[i].item.Index < group.photos[j].item.Index
		})
		group.CoverResourceID = group.photos[0].item.ID
		groups = append(groups, *group)
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].FileCount != groups[j].FileCount {
			return groups[i].FileCount > groups[j].FileCount
		}
		return groups[i].ID < groups[j].ID
	})
	return groups
}

func gpsLocationID(cell string) string {
	sum := sha256.Sum256([]byte(cell))
	return "loc_" + hex.EncodeToString(sum[:8])
}

// GPSLocationID 返回坐标所属的离线地点相册 ID，与地点页使用同一 geohash 精度。
func GPSLocationID(latitude, longitude float64) string {
	if !validCoordinates(latitude, longitude) {
		return ""
	}
	return gpsLocationID(encodeGeohash(latitude, longitude, gpsLocationGeohashPrecision))
}

func encodeGeohash(latitude, longitude float64, precision int) string {
	const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz"
	latMin, latMax := -90.0, 90.0
	lonMin, lonMax := -180.0, 180.0
	result := make([]byte, 0, precision)
	value, bits, even := 0, 0, true
	for len(result) < precision {
		value <<= 1
		if even {
			middle := (lonMin + lonMax) / 2
			if longitude >= middle {
				value |= 1
				lonMin = middle
			} else {
				lonMax = middle
			}
		} else {
			middle := (latMin + latMax) / 2
			if latitude >= middle {
				value |= 1
				latMin = middle
			} else {
				latMax = middle
			}
		}
		even = !even
		bits++
		if bits == 5 {
			result = append(result, alphabet[value])
			value, bits = 0, 0
		}
	}
	return strings.ToLower(string(result))
}

func validateGPSLocationID(id string) bool {
	if len(id) != len("loc_")+16 || !strings.HasPrefix(id, "loc_") {
		return false
	}
	_, err := hex.DecodeString(id[len("loc_"):])
	return err == nil
}
