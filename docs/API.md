# HTTP API

> 当前接口契约只接受服务端生成的资源 ID。除本机配置管理接口外，响应、URL 和请求体均不得出现绝对文件系统路径。

## 通用约定

- 基础地址：`http://127.0.0.1:8080`。
- `accessMode=local` 时所有 API 只接受回环请求和 `localhost`/回环 IP Host；`accessMode=lan` 时可使用 IP 或 `host` 中明确配置的主机名，仅健康检查与会话端点公开，其余 API 必须带 Bearer 令牌或有效 HttpOnly 会话 Cookie。令牌不接受 query 参数。所有模式都会拒绝任意域名 Host 与浏览器跨源请求。
- 内置服务器不终止 TLS；LAN 模式只面向可信家庭网络，不应直接暴露到互联网或不可信 Wi-Fi。同网段监听者仍可能看到首次登录令牌或明文 HTTP 会话。
- 资源校验错误使用 `{ "code": "...", "message": "..." }`；媒体不存在或 ID 已过期时重新扫描。所有 4xx/5xx 响应统一为：

  ```json
  { "code": "snake_case_id", "message": "...", "details": { } }
  ```

  `code` 是稳定字符串，前端用此做 `if (err.code === 'video_cover_missing')` 区分。
- `r_`、`a_`、`c_`、`f_` 分别表示根、相册、集合和文件资源 ID。
- 资源 ID 在根目录和相对路径不变时保持稳定，不包含可逆的绝对路径信息。
- SSE 响应使用 `text/event-stream`，客户端断开后服务端必须清理订阅。
- SSE 事件名：扫描用 `pending / running / complete / cancelled / error`，
  转码用 `progress / done`（与扫描命名空间分离，避免命名冲突）。
- 错误响应 code 速查（持续扩充）：
  - `missing_resource_id` (400) - 缺少资源 ID
  - `unsupported_video_format` (415) - 视频扩展名不在白名单
  - `unsupported_format` (415) - 缩略图不支持的图片格式
  - `video_not_found` (404) - 视频文件不存在
  - `source_not_found` (404) - 缩略图源文件不存在
  - `video_cover_missing` (404) - 视频封面未生成，前端抽帧后回传
  - `stat_failed` (500) - os.Stat 系统错误
  - `media_read_failed` (500) - 媒体打开或读取文件信息失败
  - `invalid_range` (416) - 媒体字节范围无效、不支持多段范围或未命中文件大小
  - `thumbnail_error` (500) - 缩略图生成失败
  - `invalid_resource_id` (400) - 资源 ID 解析失败
  - `album_not_found` (404) - 相册路径不在当前扫描结果中

### ETag / 304 协商

`/api/thumbs/:fileId` 和 `/api/media/:fileId` 在 200 响应中带 `ETag` 头，值为**双引号包裹**的派生哈希：

- 缩略图：`"<sha256(JPEG 响应字节)>"`，尺寸变化或视频封面重写都会重新验证实际内容
- 媒体文件：`"<hex_mtime_ns>-<hex_size>"`

客户端带 `If-None-Match` 命中当前 ETag 时返回 `304 Not Modified` + 空 body。按 [RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2) 使用弱比较：当前 ETag 为 `"abc"` 时，`W/"abc"`、`"old", "abc"` 均可命中；`*` 对存在的资源也返回 304。重复字段行按逗号列表合并，引号内的逗号属于标识内容。标识仍须带双引号，格式错误的列表不命中；该弱比较不用于 If-Range。

缩略图先取得内存或磁盘缓存中的实际 JPEG 再校验；原图和视频以实际发送文件的元数据校验。源文件不存在或失效时先返回 404，通配符不绕过源校验。原图、视频和缩略图使用 `Cache-Control: private, no-cache`，成功及 304 响应保留此策略；原图和视频的 200、206、304 均携带 ETag。缓存条件命中先于 Range 判断，304 不携带 Content-Range。

原图和视频在没有 `If-None-Match` 时支持 `If-Modified-Since`，按文件修改时间的秒精度返回 304，并保留 ETag、Last-Modified 与缓存策略。两者同时出现时以 `If-None-Match` 为准；ETag 未命中不会被时间条件再次判为 304。304 不携带媒体字节，客户端仍可复用已验证的内容。

4xx 响应（视频 `video_cover_missing` 404、源文件不存在等）**不**带 ETag —— 4xx 状态本身是临时的（cover 抽帧后变 200），不能让浏览器把 404 缓存住。

服务端在以下事件时 ETag 必然变化（缓存自动失效）：

- 源文件 `mtime` 变化（修改、覆盖、抽取新封面）
- 源文件 `size` 变化
- 视频经转码后由转码缓存文件代替原文件，ETag 派生的是实际发送文件
- 视频经 faststart remux 后同上

## 健康与配置

### `GET /api/health`

LAN 模式下未认证响应只包含 `status` 与 `accessMode`，避免公开根 ID 和运行时指纹。local 模式或 LAN 已认证请求还返回版本、Go 版本、goroutine 数、脱敏根 ID 和能力位；`mediaRoots` 中只包含 `r_` ID。

### `/api/auth/session`

- `GET`：返回 `{ "authenticated": true|false, "mode": "local|lan" }`，不返回凭据。
- `POST`：body 为 `{ "token": "..." }`，成功后设置 8 小时、`HttpOnly`、`SameSite=Strict`、`Path=/api` 会话 Cookie。也可用 `Authorization: Bearer <token>`。
- `DELETE`：删除当前服务端会话并清理 Cookie。

轮换 `accessToken` 后，用旧令牌签发的会话立即失效。前端只把令牌提交给会话端点，不写入 URL、localStorage 或业务 store。

认证请求体最大 1 KiB，令牌最大 256 字符；同一来源 5 分钟内超过 8 次失败返回 `429 too_many_auth_attempts`。正确令牌不会被失败计数锁死，并会清理该来源计数。

### `GET /api/config` / `PUT /api/config`

读取或更新 `config.yaml`。与下文的目录选择接口同属允许处理绝对路径的本机配置管理例外，只接受服务端回环地址请求；远程请求返回 `403 local_access_required`。

可更新字段：`mediaRoots`、`host`、`port`、`accessMode`、`accessToken`、`cacheDir`、`thumbSizeW`、`thumbSizeH`、`thumbCacheSize`、`cacheMaxAgeDays`、`ffmpegPath`、`allowOsOpen`、`staticDir`、`skipHidden`、`excludePatterns`、`systemFiles`。`accessToken` 永不在 GET/PUT 响应中回显，只返回 `accessTokenConfigured`。

`mediaRoots` 相对进程 CWD 绝对化、清理路径分隔与 `.`、去空并保序去重，响应和写回 YAML 均使用规范化后的路径，保留首次出现的大小写。Windows 比较时忽略大小写，其他平台区分大小写；不通过解析符号链接或 junction 合并不同路径。仅增加等价写法、重复项或调整顺序时，`mediaRootsChanged=false`，保留现有媒体库、revision 和有效扫描缓存。

`host`、`port`、`cacheDir`、`ffmpegPath` 和 `staticDir` 修改后需要重启；`accessMode` 与 `accessToken` 可热更新，其中 LAN 令牌必须是 32-256 个无空白字符。缩略图尺寸、LRU、保留天数和 `allowOsOpen` 也可热更新，媒体根和扫描排除规则在下一次扫描生效。

## 图像库与扫描

### `POST /api/scans`

启动后台扫描，返回 `{ "scanId": "...", "reused": false }`。已有活动任务时不会重复扫描，返回相同 ID 和 `reused: true`。

### `GET /api/scans/:scanId/events`

订阅扫描事件。事件名为 `pending`、`running`、`complete`、`cancelled` 或 `error`；`currentPath` 仅包含根别名和相对路径。

`pending` 和 `running` 都保持连接，只有终态或通道关闭才结束正常推送；空闲期间每 15 秒发送 `: keep-alive` 注释心跳，心跳不包含业务事件。写入或刷新失败后释放当前订阅，不取消扫描任务或其他客户端的订阅。

重新连接会先收到最新事件快照，保留原事件的进度、阶段、已发现数量、`elapsedMs` 与 `libraryRevision`（如有）；已结束任务返回原始终态后关闭连接，不将取消或失败进度强制改为 100%。内部扫描错误仍只公开机器可读的错误码（`scan_failed`、`root_missing`、`root_not_dir`、`root_unreadable`、`root_changed`），界面据此翻译成中文说明；未知或已过保留期的任务返回 `404 scan_not_found`。

`albumsFound` 累计本轮所有根中已发现的相册，包含本目录媒体视图，切换根目录不会清零。`progress` 为不回退的预估百分比，不代表剩余文件数或耗时：根目录等分读取阶段 0–95% 的预算，整理阶段为 99%，快照成功发布后的 `complete` 为 100%。取消或失败沿用最后一次有效事件的进度、相册数、阶段和相对路径，不发布新的媒体库 revision。

扫描启动时记录各根目录身份，并在各根读取前后、整理后和提交前复核可读性与身份。检查发现根目录消失、不可读、变为文件或被新目录替换时，发送 `error`（`error` 为对应错误码，`currentPath` 给出媒体根别名，不含绝对路径），保留旧 manifest、revision 和磁盘扫描缓存，不发布部分根结果。可读的空根合法；根仍可用时，普通子目录读取失败继续作为 `directory_unreadable` 告警。

父子目录可同时配置为根，两个来源均保留。父根遍历时跳过单独配置的子根，由子根独立扫描；相册、集合及 `sourceRoot` 归属于最具体的根，根顺序不影响归属与资源 ID。子根自身由根节点表示，集合统计只计入根下的集合，目录分页不重复展示子根包装层或相册。SSE 的 `currentPath` 同样使用最具体根的别名和相对路径；内部显式 `MaxDepth` 按各根独立计算，委派给子根不产生跳过告警。

显式配置的符号链接或 Windows junction 目录可作为独立根；媒体请求与扫描进度共用最具体根的匹配规则，根的排列顺序不影响访问。该根本身是授权边界，其内部未单独配置的链接仍拒绝访问；移除链接根后，父根不继续授予链接目标访问权。扫描遇到未配置的链接时返回 `symlink_skipped` 告警，即使链接名带图片或视频扩展名也不收录为媒体。目录选择器仍返回解析链接后的真实路径，手动填写链接根沿用现有路径规范化规则。

### `DELETE /api/scans/:scanId`

取消扫描。取消信号会终止目录读取，取消后的任务不得写入图像库缓存。

扫描结果可包含 `warnings`：每项只有稳定 `code`、根别名/相对 `path` 和用户可读 `message`，不会暴露绝对路径。混合目录中的“本目录媒体”相册带 `virtual: true`，其相册 ID 与集合 ID 不同，但二者解析到同一真实目录。`collection.albumCount` 统计全部后代相册。

虚拟相册的 `name` 恒为“本目录媒体”（区分相册类型的语义常量），`displayName` 是归属目录，另带 `location`：归属目录相对所属媒体根的路径，用斜杠分隔，例如 `2020年`、`2011年/10.1一号公馆`；根目录自身的散图用根目录名。`location` 是这些相册在未读/最近等扁平列表里的唯一可辨识标识，搜索也按它命中；普通相册没有该字段。

相册同时返回 `date` 与 `dateSource`。`dateSource` 取值为 `captured` / `folder` / `modified`，服务端按该顺序降级；目录日期只接受 `YYYY`、`YYYY-MM`、`YYYY-MM-DD`、`YYYYMMDD` 或严格的 `YYYY/MM/DD` 路径分段，不会从任意名称子串中猜测。

媒体库浏览只使用下列 revision 分页接口：

- `GET /api/library/manifest`：返回根列表、扫描时间和相册/集合/标签/告警统计，不包含目录树或媒体数组；`warnings` 最多返回前 100 条脱敏告警详情，完整数量见 `statistics.warningCount`。
- `GET /api/library/activity-summary`：返回当前 revision 的 `albumCount` 与 `unreadCount`，供常驻导航显示未读 badge；不返回相册清单或活动详情。
- `GET /api/library/dashboard`：返回首页所需的 `albumCount`、`unreadCount`、最多 6 本 `unread` 相册摘要与全部 `inProgress` 阅读摘要；不返回全量相册列表。每条在读摘要的 `pageCount` 始终以当前扫描结果为准。
- `GET /api/library/unread?limit=60&cursor=...`：分页返回尚未翻开过的相册摘要；已读和在读相册不会传输。有图片的相册以图片阅读活动判定，纯视频相册以视频播放活动判定（没有图片活动可依）。
- `GET /api/library/:rootOrCollectionId/children?limit=60&cursor=...`：分页返回直属相册与子集合摘要。
- `GET /api/albums/random?scope=unread`：随机返回一个相册摘要；不传 `scope` 时从全库抽取，`scope=unread` 时只从尚未保存图片阅读活动的相册中抽取。没有匹配相册返回 `404 no_matching_album`。
- `GET /api/albums/:albumId/media?limit=60&cursor=...`：按统一自然顺序返回媒体；`index` 是相册内总序号，`kindIndex` 是图片或视频各自序号。
- `POST /api/library/nodes/query`：body 为 `{ "ids": ["a_...", "c_..."] }`，按输入顺序批量解析相册/集合摘要；单批最多 500 项，失效 ID 返回在 `missing` 中。
- `GET /api/tags?limit=60&cursor=...`：分页返回标签摘要。
- `GET /api/tags/:tag/albums?limit=60&cursor=...`：分页返回标签下的相册摘要。`tag` 按单个 URL 路径段编码，服务端只解码一次，支持中文、空格、`+`、`%` 及字面 `%xx`；非法百分号编码返回 `400 invalid_tag`，解码后为空返回 `400 missing_tag`，不存在的标签返回 `404 tag_not_found`。

`limit` 默认 60、最大 200。响应统一为 `{ "ok": true, "page": { "revision": 42,
"items": [], "total": 0, "nextCursor": "..." } }`；manifest 和分页响应都带
`ETag: W/"library-<revision>"`。游标带签名并绑定资源作用域与 revision，篡改或跨资源
复用返回 `400 invalid_cursor`，扫描发布新版本后返回 `409 stale_cursor`，客户端应丢弃
已合并页面并从 manifest 重试。

节点摘要不携带媒体数组。相册摘要通过 `tags: string[]` 返回目录名解析出的全部标签，
不再提供单标签别名字段。集合摘要的 `albumCount`、`imageCount`、`videoCount`、
`mediaCount` 和 `folderSize` 均包含所有后代，`childCount` 仍只表示直属子项数量。
相册摘要的 `hasCustomCover` 为 `true` 时表示当前 revision 已应用用户设置的人工封面；
失效的覆盖记录不会出现在此字段中。

### `DELETE /api/library`

取消活动扫描，使它的提交令牌失效，并清除内存资源快照与磁盘扫描缓存；不会立即发起新扫描。

## 相册与搜索

### `GET /api/search?q=<keyword>&limit=50`

搜索按名称和标签匹配相册、集合和标签，结果中的 `path` 是相册/集合 ID；相册与标签结果可带 `tags: string[]`。标签结果使用 `smart:<tag>` 作为内部标签标识，前端统一转换到 `/tags/<tag>`。搜索条目在每次媒体库 revision 发布时预计算，查询不会递归读取完整目录树。

散图（"本目录媒体"）的搜索条目 `name` 是归属目录路径，并带 `virtual: true`：它的展示名与同名集合完全一致，前端据此把类型标签显示成"本目录媒体"而不是"文件夹"。

### `PUT /api/albums/:albumId/cover?file=<fileId>`

设置自定义封面。文件必须属于相册、已被本次扫描收录，且为受支持图片或视频。覆盖在每次新扫描发布前重新验证和应用，不会因重扫丢失；已移动/删除的封面记录会被忽略。

### `DELETE /api/albums/:albumId/cover`

清除自定义封面并恢复扫描器默认封面。

## 媒体、缩略图与视频

配置接口支持 `cacheMaxSizeMB`（整数 MiB，0～1048576，默认 10240；0 不限制容量）。与 `cacheMaxAgeDays` 一起在下一轮自动维护生效，无需重启。启动时及每小时检查一次，只删除派生目录中的完整缓存文件；十分钟内的新文件与临时产物保留，因此容量是软上限。状态数据不参与清理。

### `GET /api/media/:fileId`

发送图片或视频，支持 ETag 和 Range；视频按需经过转码和 faststart 管线。

前端视频消费使用 `/api/media/:fileId?playback=<不透明播放标识>`。每次播放切换、重试、转码后重新加载和抽帧生成新标识，同次播放的多个 Range 请求沿用同一 URL；标识用于隔离浏览器媒体缓冲。服务端仍只按文件 ID 校验权限并选择当前文件，`playback` 不选择文件版本、不传递路径或凭据，也不替代收藏、历史和活动记录中的资源 ID。直接使用不带标识的资源地址仍须重新验证 HTTP 缓存。

原图与视频的每个响应独立打开最终选择的文件，ETag、Last-Modified、Content-Length 和 Range 总长度来自该次打开的文件信息，不复用旧文件句柄或旧长度。同一路径在响应之间被覆盖、缩小或替换后，无需等待文件服务缓存过期。流在完成或中断后关闭；HEAD、304 和错误响应也释放句柄。

支持单段 `Range: bytes=start-end`、`bytes=start-` 和 `bytes=-count`。未带 `If-Range`，或其值为当前强 ETag、与 Last-Modified 精确到秒相同的 HTTP 日期时，按范围返回 `206`。`If-Range` 过期、为弱 ETag、ETag 列表、无效值或不匹配的日期时，忽略 Range 并返回完整当前文件（`200`，不带 Content-Range），即使该 Range 越界也不会返回 416。常规缓存条件先于 If-Range 判断；匹配的 If-None-Match 仍返回 304。

需要处理范围时，无效范围、空后缀或多段范围返回 `416 invalid_range`，携带 `Content-Range: bytes */<当前大小>` 和 `Cache-Control: no-store`，不带 ETag。HEAD 不传输媒体内容；不带 Range 时返回当前完整长度。

响应前确认源路径仍为普通文件；扫描后被目录或其他非普通文件替换时，图片返回 `404 media_not_found`，视频返回 `404 video_not_found`。此检查先于 ETag、Range、转码缓存选择和文件发送，不返回目录重定向或携带本地路径的 `Location`，也不因条件请求返回 304。源文件恢复后，原 ID 可继续使用。

视频派生缓存仅命中非空普通文件，不跟随缓存条目自身的链接。空文件、目录及链接不会直接发送或用于 304 协商；空缓存按需重新生成，生成失败时沿用后续 faststart 或源文件流程，不返回缓存目录重定向。目录占位及其内容保留。

### `GET /api/thumbs/:fileId`

返回 JPEG 缩略图。视频尚无封面时返回 `404` 和 `code: video_cover_missing`。

源路径不存在或不再是普通文件时返回 `404 source_not_found`；先校验源类型，再查询内存/磁盘缓存或尝试抽帧，不将目录误报为 `video_cover_missing`。

纯 Go 解码器不支持的图片格式（HEIC/HEIF 等 iPhone 照片）优先用 ffmpeg 转换后生成缩略图；ffmpeg 不可用或转换失败时返回 `415 unsupported_format`，前端显示占位图而不是破图。

### `POST /api/thumbs/:fileId/cover`

上传浏览器抽取的视频封面，body 为 JPEG/PNG 原始字节，最大 5 MiB。

源视频路径不存在或不再是普通文件时返回 `404 source_not_found`，不解码上传内容、不写入封面缓存。

### `GET /api/images/:fileId/info`

仅接受图片文件资源 ID，返回图片尺寸、格式、大小、修改时间和 checksum。`path` 为文件 ID，`name` 为文件名，`dir` 为所在目录的“根别名/相对父目录”，不包含文件名；根目录直属图片的 `dir` 只有根别名。例如 `name: "page.png"`、`dir: "素材/相册"`。

| 状态 | code                       | 含义                                 |
| ---- | -------------------------- | ------------------------------------ |
| 400  | `invalid_resource_kind`    | 传入根、相册或集合 ID                |
| 404  | `resource_not_found`       | ID 无效、已过期或不在当前媒体根中    |
| 404  | `media_not_found`          | 已收录的源路径不存在或不再是普通文件 |
| 415  | `unsupported_image_format` | 文件不是受支持图片，例如视频文件     |
| 500  | `image_info_failed`        | 无法读取或解码图片                   |

### `GET /api/videos/:fileId/info`

仅接受视频文件资源 ID，返回视频基础信息、可用时的元数据和转码状态。元数据优先通过 ffprobe 读取，缺失或失败时回退到 ffmpeg；两种工具都不可用时仍返回基础字段。回退结果的时长和码率遵循工具文本输出精度，未知数值以 0 表示，不返回 NaN 或无穷值。`path` 始终为文件 ID，`name` 为文件名，`dir` 与图片信息接口一致，只包含根别名和相对父目录。

| 状态 | code                       | 含义                              |
| ---- | -------------------------- | --------------------------------- |
| 400  | `invalid_resource_kind`    | 传入根、相册或集合 ID             |
| 404  | `resource_not_found`       | ID 无效、已过期或不在当前媒体根中 |
| 404  | `video_not_found`          | 视频源路径不存在或不再是普通文件  |
| 415  | `unsupported_video_format` | 文件不是受支持视频                |
| 500  | `video_info_failed`        | 无法读取文件信息                  |

### `POST /api/videos/info/batch`

批量返回视频基础信息、ffprobe 元数据和转码状态，避免视频列表为每个卡片
单独请求。请求体为 `{ "ids": ["f_...", "f_..."] }`，单次最多 100 个
文件 ID。响应为 `{ "ok": true, "items": [{ "id": "f_...", "info": {...} }] }`；
结果保留输入顺序及重复项。单项失败不返回 `info`，其 `code` 为
`resource_not_found`（ID 失效、路径含链接或不在当前媒体根中）、`invalid_resource_kind`（目录资源）、
`unsupported_video_format`（非视频）、`video_not_found`（源路径不存在或不再是普通文件）
或 `video_info_failed`（文件信息读取失败），不会使整批失败。
成功项的 `info.path`、`info.dir` 与单条接口采用相同的文件 ID 和父目录语义。

每项都按当前媒体根重新校验路径，拒绝扫描后被替换为符号链接或 junction 的目录，校验失败不会读取或探测该文件。服务未配置资源目录或路径校验器时返回 `500 video_info_unavailable`。

### 视频转码

- `GET /api/videos/:fileId/transcode/status`
- `GET /api/videos/:fileId/transcode/events`
- `POST /api/videos/:fileId/transcode/cancel`

转码状态查询（`/status`）、视频信息响应及进度流终态快照中的 `cached` 要求当前缓存仍为非空普通文件。已完成任务的缓存丢失、清空或变为非普通文件后，查询与重新订阅状态为 `failed`；下一次媒体请求可重新排队生成。目录占位导致发布失败时保持 `failed`，不删除占位目录。

`/events` 使用 SSE。排队与运行中的任务发送 `event: progress`，结束时发送一条 `event: done` 并关闭连接；事件 data 均为 `{ status, progress, etaSec, error? }`。`etaSec` 是按「已耗时 × 剩余比例」线性外推的剩余秒数估算，进度为 0（刚开始）或任务未开始时为 0，表示未知；估算封顶 24 小时。没有活动任务时，按当前状态查询结果发送一条完整的 `done` 快照后关闭：磁盘缓存可用为 `cached`，原生可播放为 `not_needed`，工具不可用为 `unavailable`，需要转码但任务还没启动为 `pending`。迟到或重复订阅同样复核当前状态，不发送空对象作为终态，不因内存中缺少任务记录而误报缓存不可用。

`pending` 表示"这个视频需要转码，但转码任务还没开始"——转码由媒体请求按需触发，播放之前既没有缓存也没有在跑的任务。这不是故障：状态查询返回 `pending` 且不带 `error`，前端不应据此显示"转码失败"。缓存条目存在但无效（空文件或目录）仍报 `failed`。

任务与当前源文件大小、纳秒修改时间及转码 profile 关联；大小或修改时间变化后，查询和新订阅不沿用旧版本进度或错误，新媒体请求取消旧任务并按需启动当前版本。当前版本的有效磁盘缓存优先于内存任务状态，缓存恢复后可直接返回 `cached`。任务在启动或发布前发现源版本变化时，不发布该次产物，原任务进度流返回 `failed`，`error` 为 `video source changed`；下一次媒体请求按新版本处理。旧版本被新请求主动取消时，其原订阅仍收到取消终态。

## 收藏、历史与媒体活动

偏好文件只保存稳定资源 ID。加载时会丢弃不符合当前资源 ID 格式的记录，避免暴露本机路径。

偏好响应中的 `favorites`、`history` 以及清理响应中的 `removed` 始终为数组；没有条目时返回 `[]`，不返回 `null`。删除最后一个收藏、清空最近访问和无变化清理同样遵循此约定。

- `GET /api/prefs`、`PATCH /api/prefs`：读取或修改界面偏好。高频媒体活动不再混入偏好响应。
- `GET /api/favorites`：返回 `{ "favorites": ["<resourceId>"] }`。
- `POST /api/favorites`、`DELETE /api/favorites`：body 为 `{ "resourceId": "a_... | c_... | smart:<tag>" }`。
- `POST /api/favorites/prune`：按当前资源目录移除已失效相册/集合 ID，返回 `{ "removed": ["<resourceId>"] }`，不访问 ID 对应的文件路径；智能标签保留。资源目录尚未完成首次加载时返回 `409`，不会删除收藏。
- `GET /api/history`、`DELETE /api/history`。
- `POST /api/history`：body 为 `{ "albumId": "a_...", "name": "...", "imageCount": 42 }`。

媒体活动使用复合标识：图片为 `albumId + mediaKind=image`，视频为
`albumId + mediaKind=video + itemId`。图片页码与每个视频的播放位置不会互相覆盖。

- `GET /api/activity?albumId=<albumId>&mediaKind=image`：读取图片活动。视频查询还必须传 `itemId=<fileId>`。
- `PUT /api/activity`：幂等写入单条活动。图片 body 为 `{ "albumId": "a_...", "mediaKind": "image", "pageIndex": 12, "pageCount": 30 }`；视频 body 为 `{ "albumId": "a_...", "mediaKind": "video", "itemId": "f_...", "positionMs": 42000, "durationMs": 120000 }`。
- `POST /api/activity/query`：body 为 `{ "items": [{ "albumId": "a_...", "mediaKind": "image" }] }`，按精确标识批量读取，返回 `{ "activities": [], "count": 0 }`。
- `PUT /api/activity/batch`：body 为 `{ "activities": [...] }`，整批校验后一次原子落盘；单批最多 10000 条。
- `DELETE /api/activity?...`：幂等删除单条；`DELETE /api/activity/all` 清空全部图片和视频活动。

`/api/library/activity-summary`、`/api/library/dashboard` 与 `/api/library/unread` 均按相册的实际媒体判定未读：有图片的相册以是否存在图片阅读活动为准，纯视频相册没有图片活动，改以是否存在视频播放活动为准——播放过就不再计入未读，避免视频相册永久停留在未读列表。前者用于常驻导航，仪表盘用于首页，专用分页端点用于完整未读列表。

响应中 `status` 为 `in_progress` / `completed`，由服务端按实际位置派生。图片到达
`pageCount - 1` 完成；视频到达 98% 完成。`/api/progress` 不提供。

图片 `pageIndex` 表示当前视图实际展示的最末页：单页模式为当前页，双页模式为跨页
右侧页，连续模式为可见区末页。读取不存在的记录返回 `404 activity_not_found`；标识或
数值非法返回 `400 invalid_activity_identity` / `400 invalid_activity`；持久化不可用返回
`500 activity_unavailable`。前端只把明确的 `activity_not_found` 当作新记录，其他错误
不会开放自动写入，避免恢复失败时覆盖已有位置。

## 缓存与系统操作

- `GET /api/cache/stats`：返回脱敏缓存名称、占用和文件数。
- `POST /api/thumbs/cleanup`
- `POST /api/cache/clear?scope=thumbs|faststart|transcode|all`：统一清空入口，按 scope 删 thumbs / faststart / transcode 缓存中对应的一类；scope=all 同时清理三类派生缓存和视频元数据内存摘要。响应 `{ scope, thumbs?, faststart?, transcode?, totalDeleted, totalFreedBytes }`，未涉及的 scope 字段省略。删除数量与释放字节只统计磁盘文件，不包含内存摘要。
- `POST /api/fs/open`：本机接口，body 为 `{ "id": "<resourceId>" }`。执行前按当前媒体根重新校验路径；根、集合和相册必须仍为目录，文件必须仍为普通文件。
- `GET /api/admin/fs/open?path=<configuredPath>&allowConfig=1`：设置页专用，仅允许打开已配置路径且只接受回环请求。

系统打开操作有副作用，前端不自动重试请求；配置目录打开的 GET 同样不缓存响应。

`POST /api/fs/open` 拒绝扫描后出现在根内路径中的符号链接或 Windows junction，`allowConfig` 查询参数不能豁免该资源校验。主要错误如下：

| 状态 | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_resource_id` | 缺少 ID 或请求体非法 |
| 403 | `os_open_disabled` / `local_access_required` | 系统打开未开启或请求来自远程 |
| 404 | `resource_not_found` | ID 无效、已过期、路径不在当前根中、含链接、资源不可用或类型已变化 |
| 500 | `os_open_failed` | 校验或系统打开依赖不可用，或系统打开执行失败 |

### `POST /api/admin/fs/directories`

设置页的目录选择接口，沿用 `AccessGate` 的认证、Host 和同源校验，且额外要求回环地址；LAN 认证成功的远程客户端仍返回 `403 local_access_required`。不受 `allowOsOpen` 控制，不会启动系统文件管理器。

请求体为 `{ "directory": "<目录路径>", "after": "<上一页游标>" }`。两字段可省略：空目录从服务进程用户的主目录开始，空游标读取第一页。相对路径按服务进程 CWD 解析，成功结果返回规范化、解析链接后的完整路径。该接口有意允许浏览媒体根之外的目录，供新增媒体根、缓存和静态资源配置使用。

```json
{
  "directory": "/home/user/photos",
  "parent": "/home/user",
  "roots": ["/"],
  "items": [{ "name": "旅行", "path": "/home/user/photos/旅行" }],
  "nextAfter": ""
}
```

`roots` 为 Windows 逻辑盘根列表，或 macOS/Linux 的 `/`；文件系统根的 `parent` 为空。仅返回直属目录，跳过普通文件和目录链接；按目录名的 UTF-8 字节序升序，每页最多 200 项。`nextAfter` 非空时用原值请求下一页；为空时已到末页。分页使用实时文件系统视图，目录发生变化后可重新前往该目录刷新。响应 `Cache-Control: no-store`，完整路径只用于设置组件的临时状态，不写入浏览器持久化 store；请求路径放在 JSON body 中，访问日志不记录 body。

| 状态 | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_directory_request` | 请求体非法、路径含 NUL 或目标不是目录 |
| 403 | `directory_access_denied` | 服务进程没有读取目录的权限 |
| 404 | `directory_not_found` | 目录不存在或离线 |
| 500 | `directory_read_failed` | 目录读取失败，错误信息不包含完整路径 |

浏览、翻页和取消不修改文件或配置。确认选择后，前端把返回的完整路径提交给现有 `PUT /api/config`；媒体根沿用停止输入 450ms 后保存，缓存与静态目录立即保存并保留需重启提示。

### 媒体目录离线与初始设置

服务启动和配置重载只校验运行参数，媒体根暂时离线或 mediaRoots: [] 不阻止访问设置页。显式 PUT 修改 mediaRoots 时校验每个非空目录存在且为目录；空数组表示主动清空配置。只修改其他设置时不检查旧媒体根是否在线。空白路径会被忽略，不会解析到进程工作目录。扫描仍要求本轮所有根可访问；失败保留上次已发布快照，不将离线目录当作删除。不支持部分根扫描发布。
