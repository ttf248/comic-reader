package models

import (
	"errors"
	"strings"
	"time"
)

// MediaKind 区分活动记录的媒体语义。图片保存相册页码，视频保存单个文件的播放时间。
type MediaKind string

const (
	// MediaKindImage 是漫画阅读进度：一本漫画读到第几页。
	MediaKindImage MediaKind = "image"
	// MediaKindPhoto 是照片浏览进度：照片墙里最后看到第几张。
	//
	// 它与漫画进度分开存：同一本相册可以在两种用途之间切换，
	// 照片浏览到第 12 张不应该变成漫画读到第 12 页。
	MediaKindPhoto MediaKind = "photo"
	// MediaKindVideo 是视频播放位置。
	MediaKindVideo MediaKind = "video"
)

// ActivityStatus 是服务端根据位置派生的状态，客户端不能单独篡改。
type ActivityStatus string

const (
	ActivityInProgress ActivityStatus = "in_progress"
	ActivityCompleted  ActivityStatus = "completed"
)

// Activity 统一表示图片阅读、照片浏览与视频播放活动。
//
// 非视频活动的唯一键是 albumId + mediaKind；视频活动再加 itemId，
// 因此同一混合相册的图片页码与每个视频的播放位置互不覆盖。
type Activity struct {
	AlbumID    string         `json:"albumId"`
	MediaKind  MediaKind      `json:"mediaKind"`
	ItemID     string         `json:"itemId,omitempty"`
	PageIndex  int            `json:"pageIndex"`
	PageCount  int            `json:"pageCount"`
	PositionMS int64          `json:"positionMs"`
	DurationMS int64          `json:"durationMs"`
	Status     ActivityStatus `json:"status"`
	Updated    time.Time      `json:"updated"`
}

// ActivityIdentity 定位一条活动，不包含可变的进度值。
type ActivityIdentity struct {
	AlbumID   string    `json:"albumId"`
	MediaKind MediaKind `json:"mediaKind"`
	ItemID    string    `json:"itemId,omitempty"`
}

// IsFileID 校验对外媒体文件 ID。
func IsFileID(value string) bool {
	return isOpaqueResourceID(value, "f_")
}

// NormalizeActivity 校验互斥字段并由实际位置派生完成状态。
func NormalizeActivity(activity Activity) (Activity, error) {
	if !IsAlbumID(activity.AlbumID) {
		return Activity{}, errors.New("invalid activity album id")
	}
	switch activity.MediaKind {
	case MediaKindImage, MediaKindPhoto:
		if activity.ItemID != "" || activity.PageCount <= 0 || activity.PageIndex < 0 ||
			activity.PageIndex >= activity.PageCount || activity.PositionMS != 0 || activity.DurationMS != 0 {
			return Activity{}, errors.New("invalid image activity")
		}
		if activity.PageIndex == activity.PageCount-1 {
			activity.Status = ActivityCompleted
		} else {
			activity.Status = ActivityInProgress
		}
	case MediaKindVideo:
		if !IsFileID(activity.ItemID) || activity.PageIndex != 0 || activity.PageCount != 0 ||
			activity.PositionMS < 0 || activity.DurationMS <= 0 || activity.PositionMS > activity.DurationMS {
			return Activity{}, errors.New("invalid video activity")
		}
		// 播放到 98% 视为完成，避免片尾黑帧或编码时长误差让记录永远停在未完成。
		if activity.PositionMS > 0 && activity.PositionMS >= activity.DurationMS-(activity.DurationMS/50) {
			activity.Status = ActivityCompleted
		} else {
			activity.Status = ActivityInProgress
		}
	default:
		return Activity{}, errors.New("invalid activity media kind")
	}
	return activity, nil
}

// Key 返回仅用于持久化索引的稳定键。键中只有不透明 ID，不会泄露路径。
func (identity ActivityIdentity) Key() (string, bool) {
	if !IsAlbumID(identity.AlbumID) {
		return "", false
	}
	switch identity.MediaKind {
	case MediaKindImage, MediaKindPhoto:
		if identity.ItemID != "" {
			return "", false
		}
		return string(identity.MediaKind) + ":" + identity.AlbumID, true
	case MediaKindVideo:
		if !IsFileID(identity.ItemID) {
			return "", false
		}
		return strings.Join([]string{string(identity.MediaKind), identity.AlbumID, identity.ItemID}, ":"), true
	default:
		return "", false
	}
}

// Identity 取出活动的不变定位字段。
func (activity Activity) Identity() ActivityIdentity {
	return ActivityIdentity{
		AlbumID:   activity.AlbumID,
		MediaKind: activity.MediaKind,
		ItemID:    activity.ItemID,
	}
}
