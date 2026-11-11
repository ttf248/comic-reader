package services

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"time"

	"github.com/evanoberholster/imagemeta"
)

// MetadataParserVersion 隔离元数据解析规则的版本；升级解析器时只需重算 metadata。
const MetadataParserVersion = "metadata-v1"

const (
	MetadataParseParsed      = "parsed"
	MetadataParseNoExif      = "no_exif"
	MetadataParseUnsupported = "unsupported"
)

// ImageMetadata 是可由源图片重建的 EXIF 摘要，不包含文件系统路径。
type ImageMetadata struct {
	Status           string       `json:"status"`
	DateTimeOriginal string       `json:"dateTimeOriginal,omitempty"`
	Orientation      uint16       `json:"orientation,omitempty"`
	CameraMake       string       `json:"cameraMake,omitempty"`
	CameraModel      string       `json:"cameraModel,omitempty"`
	GPS              *GPSMetadata `json:"gps,omitempty"`
}

// GPSMetadata 保存原始地理坐标和 EXIF 附带的坐标信息，不反向猜测城市名称。
type GPSMetadata struct {
	Latitude                   float64  `json:"latitude"`
	Longitude                  float64  `json:"longitude"`
	AltitudeMeters             *float64 `json:"altitudeMeters,omitempty"`
	DateTime                   string   `json:"dateTime,omitempty"`
	ImageDirectionDegrees      *float64 `json:"imageDirectionDegrees,omitempty"`
	ImageDirectionReference    string   `json:"imageDirectionReference,omitempty"`
	TrackDegrees               *float64 `json:"trackDegrees,omitempty"`
	TrackReference             string   `json:"trackReference,omitempty"`
	Speed                      *float64 `json:"speed,omitempty"`
	SpeedReference             string   `json:"speedReference,omitempty"`
	DilutionOfPrecision        *float64 `json:"dilutionOfPrecision,omitempty"`
	HorizontalPositioningError *float64 `json:"horizontalPositioningError,omitempty"`
	MapDatum                   string   `json:"mapDatum,omitempty"`
	ProcessingMethod           string   `json:"processingMethod,omitempty"`
	AreaInformation            string   `json:"areaInformation,omitempty"`
}

// ParseImageMetadata 从当前位置读取 EXIF。无 EXIF 或格式不支持是正常结果；
// 结构损坏等解析错误交给任务层计入单文件失败，不中断整批处理。
func ParseImageMetadata(reader io.ReadSeeker) (metadata ImageMetadata, err error) {
	defer func() {
		if recover() != nil {
			metadata = ImageMetadata{}
			err = errors.New("EXIF parser failed")
		}
	}()
	exif, err := imagemeta.Decode(reader)
	if err != nil {
		switch {
		case errors.Is(err, imagemeta.ErrNoExif):
			return ImageMetadata{Status: MetadataParseNoExif}, nil
		case errors.Is(err, imagemeta.ErrMetadataNotSupported), errors.Is(err, imagemeta.ErrImageTypeNotFound):
			return ImageMetadata{Status: MetadataParseUnsupported}, nil
		default:
			return ImageMetadata{}, err
		}
	}

	metadata = ImageMetadata{Status: MetadataParseParsed}
	if captured := exif.ExifIFD.DateTimeOriginal; !captured.IsZero() {
		metadata.DateTimeOriginal = formatExifWallTime(captured, exif.ExifIFD.OffsetTimeOriginal)
	}
	if orientation := uint16(exif.IFD0.Orientation); orientation >= 1 && orientation <= 8 {
		metadata.Orientation = orientation
	}
	metadata.CameraMake = strings.TrimSpace(exif.IFD0.Make)
	metadata.CameraModel = strings.TrimSpace(exif.IFD0.Model)

	latitude := exif.GPS.Latitude()
	longitude := exif.GPS.Longitude()
	// imagemeta does not expose whether GPSLatitude/GPSLongitude tags exist;
	// absent tags also read as (0, 0). Reject that ambiguous pair instead of
	// inventing a location at Null Island.
	if validCoordinates(latitude, longitude) && (latitude != 0 || longitude != 0) {
		gpsValues := normalizedGPSValues(exif.GPS)
		gps := &GPSMetadata{
			Latitude:         latitude,
			Longitude:        longitude,
			MapDatum:         strings.TrimSpace(exif.GPS.MapDatum()),
			ProcessingMethod: strings.TrimSpace(exif.GPS.ProcessingMethod()),
			AreaInformation:  strings.TrimSpace(exif.GPS.AreaInformation()),
		}
		// imagemeta 不暴露 GPSAltitude 标签是否存在；缺失时 Altitude() 返回 0。
		// 因此只报告非零值，避免把未知海拔显示成海平面。
		if altitude := float64(exif.GPS.Altitude()); altitude != 0 && finite(altitude) {
			gps.AltitudeMeters = &altitude
		}
		if captured := exif.GPS.GPSTimestamp(); !captured.IsZero() && captured.Year() != 1 {
			gps.DateTime = captured.UTC().Format(time.RFC3339)
		}
		if direction := exif.GPS.ImgDirectionWithRef(); gpsValues.ImageDirection != nil {
			value := *gpsValues.ImageDirection
			if finite(value) {
				gps.ImageDirectionDegrees = &value
				gps.ImageDirectionReference = direction.Ref
			}
		}
		if track := exif.GPS.TrackWithRef(); gpsValues.Track != nil {
			value := *gpsValues.Track
			if finite(value) {
				gps.TrackDegrees = &value
				gps.TrackReference = track.Ref
			}
		}
		if speed := exif.GPS.SpeedWithRef(); gpsValues.Speed != nil {
			value := *gpsValues.Speed
			if finite(value) {
				gps.Speed = &value
				gps.SpeedReference = speed.Ref
			}
		}
		if gpsValues.DOP != nil && *gpsValues.DOP > 0 && finite(*gpsValues.DOP) {
			value := *gpsValues.DOP
			gps.DilutionOfPrecision = &value
		}
		if gpsValues.HorizontalPositioningError != nil && *gpsValues.HorizontalPositioningError > 0 && finite(*gpsValues.HorizontalPositioningError) {
			value := *gpsValues.HorizontalPositioningError
			gps.HorizontalPositioningError = &value
		}
		metadata.GPS = gps
	}
	if metadata.DateTimeOriginal == "" && metadata.Orientation == 0 && metadata.CameraMake == "" && metadata.CameraModel == "" && metadata.GPS == nil {
		metadata.Status = MetadataParseNoExif
	}
	return metadata, nil
}

type normalizedGPS struct {
	ImageDirection             *float64 `json:"ImgDirection"`
	Track                      *float64 `json:"Track"`
	Speed                      *float64 `json:"Speed"`
	DOP                        *float64 `json:"DOP"`
	HorizontalPositioningError *float64 `json:"HPosErr"`
}

func normalizedGPSValues(value interface{ MarshalJSON() ([]byte, error) }) normalizedGPS {
	data, err := value.MarshalJSON()
	if err != nil {
		return normalizedGPS{}
	}
	var result normalizedGPS
	if err := json.Unmarshal(data, &result); err != nil {
		return normalizedGPS{}
	}
	return result
}

func formatExifWallTime(value time.Time, offset *time.Location) string {
	if offset == nil {
		// DateTimeOriginal 通常不含时区；保留相机记录的墙上时间，不附加虚构的 UTC。
		return value.Format("2006-01-02T15:04:05.999999999")
	}
	return value.Format(time.RFC3339Nano)
}

func validCoordinates(latitude, longitude float64) bool {
	return finite(latitude) && finite(longitude) &&
		latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
