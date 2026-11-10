# HTTP API

> 当前接口契约只接受服务端生成的资源 ID。除本机配置管理接口外，响应、URL 和请求体均不得出现绝对文件系统路径。

## 通用约定

- 基础地址：`http://127.0.0.1:8080`。
- `accessMode=local` 时所有 API 只接受回环请求和 `localhost`/回环 IP Host；`accessMode=lan` 时可使用 IP 或 `host` 中明确配置的主机名，仅健康检查与会话端点公开，其余 API 必须带 Bearer 令牌或有效 HttpOnly 会话 Cookie。令牌不接受 query 参数。所有模式都会拒绝任意域名 Host 与浏览器跨源请求。
- 内置服务器不终止 TLS；LAN 模式只面向可信家庭网络，不应直接暴露到互联网或不可信 Wi-Fi。同网段监听者仍可能看到首次登录令牌或明文 HTTP 会话。
- 资源校验错误使用 `{ "code": "...", "message": "..." }`；媒体不存在或 ID 已过期时重新扫描。所有 4xx/5xx 响应统一为：

  ```json
  { "code": "snake_case_id", "message": "...", "details": {} }
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

`/api/thumbs/:fileId`、`/api/previews/:fileId` 和 `/api/media/:fileId` 在 200 响应中带 `ETag` 头，值为**双引号包裹**的派生标识：

- 渲染图（缩略图 / 预览图）：`"<内容版本号>-<档位宽度>"`，内容版本号形如 `<mtime_ns>-<size>-r<算法版本>`
- 媒体文件：`"<hex_mtime_ns>-<hex_size>"`

渲染图的 ETag 由源文件版本与渲染档位派生，不再对响应字节做哈希：同一个版本与档位渲染出的字节是确定的，因此条件请求只要一次 stat 加一次字符串比较，不必先把整张图读进内存算 sha256。

客户端带 `If-None-Match` 命中当前 ETag 时返回 `304 Not Modified` + 空 body。按 [RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2) 使用弱比较：当前 ETag 为 `"abc"` 时，`W/"abc"`、`"old", "abc"` 均可命中；`*` 对存在的资源也返回 304。重复字段行按逗号列表合并，引号内的逗号属于标识内容。标识仍须带双引号，格式错误的列表不命中；该弱比较不用于 If-Range。

源文件不存在或失效时先返回 404，通配符不绕过源校验。原图、视频和渲染图默认使用 `Cache-Control: private, no-cache`，成功及 304 响应保留此策略；原图和视频的 200、206、304 均携带 ETag。缓存条件命中先于 Range 判断，304 不携带 Content-Range。

渲染图另有一种可长期缓存的形态：请求带上 `?v=<内容版本号>` 且该版本号与当前源文件一致时，响应改为 `Cache-Control: private, max-age=31536000, immutable`。版本号一致意味着源文件没动、渲染算法没变，这个 URL 的字节已经定死，浏览器可以长期缓存 —— 重复打开页面时这张图一次网络请求都不发。版本号对不上（源文件刚被改写）或没带时，仍按每次重新验证处理，不会给出陈旧内容。

原图和视频在没有 `If-None-Match` 时支持 `If-Modified-Since`，按文件修改时间的秒精度返回 304，并保留 ETag、Last-Modified 与缓存策略。两者同时出现时以 `If-None-Match` 为准；ETag 未命中不会被时间条件再次判为 304。304 不携带媒体字节，客户端仍可复用已验证的内容。

4xx 响应（视频 `video_cover_missing` 404、源文件不存在等）**不**带 ETag —— 4xx 状态本身是临时的（cover 抽帧后变 200），不能让浏览器把 404 缓存住。

服务端在以下事件时 ETag 必然变化（缓存自动失效）：

- 源文件 `mtime` 变化（修改、覆盖、抽取新封面）
- 源文件 `size` 变化
- 渲染算法版本变化（缩放算法、JPEG 质量或档位集合调整）
- 渲染档位宽度变化（同一个 URL 带不同 `w` 即是不同产物）
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

### 批量收藏与漫画未读重置

- `POST /api/favorites/batch` 请求 `{resourceIds:[资源ID],action:"add"|"remove"}`，一批 1–1,000 项；ID 可以是相册、集合或 `smart:<tag>`，整批校验并去重，返回 `{favorites:[当前完整收藏ID],updated:实际变化数}`。非法请求返回 `400 invalid_favorites_batch`；添加后超过既有 500 项收藏上限返回 `400 favorite_limit`，不裁掉原有收藏。一次锁内合并并只落盘一次。
- `DELETE /api/activity/batch` 请求 `{albumIds:[相册ID]}`，一批 1–1,000 项，返回 `{deleted:实际删除的漫画活动数}`。非法请求返回 `400 invalid_activity_batch`；不存在的活动幂等忽略，只重置图片阅读活动，保留视频播放位置，整批一次原子落盘。
- 批量标记已读复用 `PUT /api/activity/batch`。前端固定选择清单，先查询所选相册的当前属性和图片总数，仅提交非空漫画相册；集合、标签与照片不参与已读操作。

### 本机状态备份与恢复

三个端点均经过现有访问门禁与回环限制，响应 `Cache-Control: no-store`，错误不包含底层文件路径。

- `GET /api/admin/state/export` 下载 v1 JSON：`version`、`exportedAt`、`favorites`、`history`、`preferences`、`activities`、`covers`、`picks`。`preferences` 仅为服务端偏好字段；`covers` 每项为 `{albumId,itemId}`。不含配置、令牌、扫描缓存或浏览器本机阅读偏好。当前库无法解析的旧封面不导出，`unresolvedCovers` 报告数量，恢复目录后可再次导出。
- `POST /api/admin/state/import/preview` 请求 `{backup}`，返回 `versions`、`libraryRevision`、`ready`、分类 `counts`、`missing` 与 `skippedCovers`。未知字段、损坏 JSON、非 v1 版本、非法或重复 ID 均返回 `400 invalid_state_backup`。设置页文件上限 32 MiB，接口含 JSON 包装上限 34 MiB，超限返回 `413 state_backup_too_large`。
- `POST /api/admin/state/import` 请求 `{backup,categories,versions,libraryRevision}`；类别为 `favorites/history/preferences/activities/covers/picks`。`versions` 来自预览，是当前状态摘要，不是授权凭据。相关状态变化返回 `409 state_changed`；库变化或恢复封面时库未就绪返回 `409 library_not_ready`，均需重新预览。

覆盖前先在 `state/backups/` 保存同格式的恢复前 JSON 与仅服务端可见的完整内部封面映射；创建失败时不写入任何类别。收藏、历史和偏好共享文件，在一次锁内合并提交并保留未选类别；随后依次恢复活动、封面与精选，每个文件原子落盘。精选单独一个类别：恢复精选不动收藏，恢复收藏也不动精选。响应 `{completed,failed?,pending,code?,skippedCovers}`，失败后停止后续类别。已经完成的写入不因其他类别失败回滚，客户端不得自动重放恢复请求。

失效收藏、历史与活动保留供原有清理功能处理；封面须通过当前根、链接组件、相册成员与普通文件校验，失效项跳过。偏好中的 `maxRecent` 若会裁剪未选历史，或所选历史超过当前/所选偏好上限，返回 `400 history_limit_conflict`，需选择匹配的历史与偏好，不能静默丢失记录。首版适用于相同媒体根身份和相对路径，暂不提供目录迁移映射。

### `GET /api/config` / `PUT /api/config`

读取或更新 `config.yaml`。与下文的目录选择接口同属允许处理绝对路径的本机配置管理例外，只接受服务端回环地址请求；远程请求返回 `403 local_access_required`。

可更新字段：`mediaRoots`、`host`、`port`、`accessMode`、`accessToken`、`cacheDir`、`thumbCacheSize`、`cacheMaxAgeDays`、`cacheMaxSizeMB`、`ffmpegPath`、`allowOsOpen`、`staticDir`、`skipHidden`、`excludePatterns`、`systemFiles`。`accessToken` 永不在 GET/PUT 响应中回显，只返回 `accessTokenConfigured`。

`mediaRoots` 的每个条目同时携带目录路径与它的内容属性：`{ "path": "E:\照片", "kind": "photo" }`。`kind` 只有 `photo` 与 `comic` 两种且互斥，决定该目录里的相册与集合按哪种方式浏览、归入哪个工作台。条目写成映射但省略 `kind` 时按 `photo` 处理；非法 `kind` 返回 `400 invalid_config`。只写一个路径字符串的旧写法不再支持，启动时直接报错指出新写法。属性可热更新：它决定「相册用什么方式打开」与列表归属，保存后与路径变更一样触发自动扫描。

`mediaRoots` 相对进程 CWD 绝对化、清理路径分隔与 `.`、去空并保序去重，响应和写回 YAML 均使用规范化后的路径，保留首次出现的大小写。Windows 比较时忽略大小写，其他平台区分大小写；不通过解析符号链接或 junction 合并不同路径。仅增加等价写法、重复项或调整顺序时，`mediaRootsChanged=false`，保留现有媒体库、revision 和有效扫描缓存。

媒体根配置保存成功后，若规范路径或内容属性发生变化，服务端取消旧 generation、清库并启动最新非空根的扫描；根顺序和等价路径调整不触发扫描，空根只清库。`PUT /api/config` 成功响应增加可选 `scanId` 与 `scanStartError`：`scanId` 可交给现有 SSE 进度接口；`scanStartError=scan_start_failed` 表示配置已保存但自动扫描未能启动，可手动重试，不能将其当作配置保存失败重放。扫描属于进程生命周期，不随保存请求断连取消。

`host`、`port`、`cacheDir`、`ffmpegPath` 和 `staticDir` 修改后需要重启；`accessMode` 与 `accessToken` 可热更新，其中 LAN 令牌必须是 32-256 个无空白字符。渲染图的档位阶梯是固定实现约定（320/640/1280/1920/2560/4096），不可配置。LRU、保留天数和 `allowOsOpen` 可热更新，媒体根变更自动触发扫描，扫描排除规则在下一次扫描生效。

`cacheMaxSizeMB` 为整数 MiB，0～1048576，默认 10240；0 不限制容量。与 `cacheMaxAgeDays` 一起在下一轮自动维护生效，无需重启。启动时及每小时检查一次，只删除派生目录中的完整缓存文件；十分钟内的新文件与临时产物保留，因此容量是软上限。状态数据不参与清理。

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

扫描收录的媒体格式由服务端扩展名白名单决定（图片：jpg / jpeg / jfif / png / gif / bmp / webp / tiff / tif / heic / heif；视频：mp4 / m4v / webm / mov / mkv / avi / 3gp）。目录里只要有受支持的媒体就会生成相册；此前 3GP 不在白名单里，整目录都是 3GP 的文件夹（例如「萍乡中学/录像」）在应用里完全看不到。浏览器放不了的容器（mkv / avi / 3gp）一律走服务端转码，不按码流判断。

相册同时返回 `date` 与 `dateSource`。`dateSource` 取值为 `filename` / `folder` / `modified`，服务端按该顺序降级。`filename` 是从文件名推断的拍摄时间（`IMG_20240101_105902.jpg`、`2024-01-01`、`2024年10月1日` 这类写法），不读 EXIF；一本相册取其中出现次数最多的那一天（并列取较早的）。`folder` 只接受 `YYYY`、`YYYY-MM`、`YYYY-MM-DD`、`YYYYMMDD` 或严格的 `YYYY/MM/DD` 路径分段，不会从任意名称子串中猜测。集合与相册一样带 `date` / `dateSource` / `modTime`：集合的日期是后代相册拍摄时间的代表值（按媒体数加权取众数），没有拍摄时间时退回目录日期或目录修改时间。

媒体库浏览只使用下列 revision 分页接口。除 `/api/library/manifest`、
`/api/library/nodes/query`、`/api/tags/query` 与 `/api/albums/:albumId/media` 外，
它们都接受必填的 `kind` 查询参数，取值 `photo` / `comic`：

- `GET /api/library/manifest`：返回根列表、扫描时间和相册/集合/标签/告警统计，不包含目录树或媒体数组；`warnings` 最多返回前 100 条脱敏告警详情，完整数量见 `statistics.warningCount`。`statistics.albumCount` 恒为全库相册总数，另带 `photoAlbumCount` 与 `comicAlbumCount` 两个按属性拆分的计数——库规模不随工作台模式跳变。集合同理：`collectionCount` 恒为全库集合总数，另带 `photoCollectionCount` 与 `comicCollectionCount`。
- `GET /api/library/activity-summary`：返回当前 revision 的 `albumCount` 与 `unreadCount`，供常驻导航显示未读 badge；不返回相册清单或活动详情。两个计数都收敛到 `kind` 指定的属性。
- `GET /api/library/dashboard`：返回首页所需的 `albumCount`、`unreadCount`、最多 6 本 `unread` 相册摘要与全部 `inProgress` 阅读摘要；不返回全量相册列表。每条在读摘要的 `pageCount` 始终以当前扫描结果为准。阅读进度只属于漫画工作台：`kind=photo` 时 `inProgress` 恒为空。
- `GET /api/library/unread?limit=60&cursor=...`：分页返回尚未翻开过的相册摘要；已读和在读相册不会传输。有图片的相册以漫画阅读活动判定，纯视频相册以视频播放活动判定（没有阅读活动可依）。未读只统计漫画目录的相册：`kind=photo` 时恒为空。
- `GET /api/library/recent?limit=60`：返回该属性下最近加入的相册摘要，按业务日期倒序（`date` 缺失时退回 `modTime`）。照片工作台不记录浏览进度，没有「继续阅读」可言，这个接口是它与漫画侧对称的入口，也是收藏空态的推荐来源。不分页：`total` 是该属性下的相册总数，`items` 至多 `limit` 条。
- `GET /api/library/on-this-day?month=11&day=07&limit=20`：往年同一天（同月同日）拍过照的相册。`month` / `day` 缺省时取服务端当天；只认拍摄日期（`dateSource=filename`），没有拍摄时间的相册不在其中；今年的照片不算「往年」。同一本相册只出现一次，取它最近的一次命中。每项在相册摘要之外多给 `matchedDate`（命中的那一天，`YYYY-MM-DD`）—— 相册自己的 `date` 是「最有代表性的那一天」，未必等于命中的那一天。
- `GET /api/library/:rootOrCollectionId/children?limit=60&cursor=...`：分页返回直属相册与子集合摘要。相册与集合都继承所属目录的属性，因此都参与 `kind` 过滤；属性不匹配的目录返回空页。集合摘要的 `albumCount` 恒为全部后代。
- `GET /api/albums/random?scope=unread&count=3`：随机返回相册摘要列表；只在该属性的相册里抽取，`scope=unread` 时进一步只从未保存阅读活动的相册中抽取。`count` 缺省 1、范围 1–12，越界返回 `400 invalid_random_count`；抽出的相册互不相同，候选不足 `count` 时返回全部。没有匹配相册返回 `404 no_matching_album`。
- `GET /api/albums/:albumId/media?limit=60&cursor=...`：按统一自然顺序返回媒体；`index` 是相册内总序号，`kindIndex` 是图片或视频各自序号。图片项另带 `width` / `height`（原始像素宽高，未知时为 0），照片墙据此按真实宽高比排布，不必在浏览器里逐张探测。媒体流与工作台模式无关。媒体项另带 `picked: true`，表示这张照片在精选里（精选是照片级的用户数据，见「精选」一节）。
- 图片项还可能带 `undecodable: true`：这个文件解码不出来 —— 扩展名说是 JPEG，内容却不是，或者像素数据是截断的。判定有两个来源：读图片头就失败（当场判定），以及渲染时整张解码失败（补记，随文件版本走，文件被替换后判定作废）。需要服务端转换的格式（HEIC/HEIF/TIFF）不算坏文件，不带这个标记。界面据此显示「无法解码」。
- `POST /api/library/nodes/query`：body 为 `{ "ids": ["a_...", "c_..."] }`，按输入顺序批量解析相册/集合摘要；单批最多 500 项，失效 ID 返回在 `missing` 中。直达链接、收藏与最近浏览都靠它解析摘要，**不受工作台模式影响**。
- `GET /api/tags?limit=60&cursor=...`：分页返回标签摘要。每个标签的 `albumCount` 按 `kind` 指定的属性重算，该属性下没有相册的标签整个不出现。
- `POST /api/tags/query`：body 为 `{ "names": ["共同", "连载"] }`，按输入顺序批量解析标签摘要；单批最多 500 项。它**不按工作台属性过滤**，而是同时给出 `photoAlbumCount` 与 `comicAlbumCount`，客户端据此区分「这个标签失效了」和「它只属于另一侧」。库里根本没有的标签名进 `missing`。
- `GET /api/tags/:tag/albums?limit=60&cursor=...`：分页返回标签下的相册摘要。`tag` 按单个 URL 路径段编码，服务端只解码一次，支持中文、空格、`+`、`%` 及字面 `%xx`；非法百分号编码返回 `400 invalid_tag`，解码后为空返回 `400 missing_tag`，不存在的标签返回 `404 tag_not_found`。

`kind` 过滤全部命中：相册与集合按其目录属性归属，标签则按「该属性下是否还有相册」判断——只含漫画的标签不出现在照片工作台的结果里。缺失或非法取值返回 `400 invalid_kind`。

`limit` 默认 60、最大 200。响应统一为 `{ "ok": true, "page": { "revision": 42,
"items": [], "total": 0, "nextCursor": "..." } }`；manifest 和分页响应都带
`ETag: W/"library-<revision>"`。游标带签名并绑定资源作用域与 revision，篡改或跨资源
复用返回 `400 invalid_cursor`，扫描发布新版本后返回 `409 stale_cursor`，客户端应丢弃
已合并页面并从 manifest 重试。**切换工作台模式后旧游标一律失效**（作用域含目录属性），
客户端应从第一页重新拉取。

节点摘要不携带媒体数组。相册摘要通过 `tags: string[]` 返回目录名解析出的全部标签，
不再提供单标签别名字段。相册摘要的 `parentName` 是它直接上级集合的名字，也就是
「所属系列」——漫画目录里一连载多卷时，它标出这一卷属于哪部作品；根目录下的相册
没有上级集合，该字段为空。节点摘要的 `parentId` 是同一件事的另一种形式：直接上级
集合的资源 ID。顶层集合与根目录下的相册没有上级集合，该字段为空；客户端据此
逐级向上解析，拼出「存照 / 萍乡中学 / 3班running man」这样的面包屑。散图
（虚拟相册）是某个目录里的散落媒体，与同名集合同处一个目录，因此它的上级是那个
集合本身而不是集合的父目录。漫画工作台的首页按作品索引，索引项取自根目录下的集合
（集合的成员由服务端聚合成 `albumCount`）。集合摘要的 `albumCount`、`imageCount`、`videoCount`、
`mediaCount` 和 `folderSize` 均包含所有后代，`childCount` 仍只表示直属子项数量。
相册摘要的 `hasCustomCover` 为 `true` 时表示当前 revision 已应用用户设置的人工封面；
失效的覆盖记录不会出现在此字段中。

节点摘要的 `contentKind` 是该节点的内容属性（`photo` 照片墙 / `comic` 漫画阅读器），
完全继承自所属媒体根的属性。属性决定点击相册后进入照片墙还是阅读器，也决定它
出现在哪个工作台；它与相册里是图片还是视频无关，也不按图片数量推断。
`/api/library/manifest` 的根摘要同样带 `contentKind`。

### `DELETE /api/library`

取消活动扫描，使它的提交令牌失效，并清除内存资源快照与磁盘扫描缓存；不会立即发起新扫描。

## 相册与搜索

### `GET /api/search?q=<keyword>&limit=50&kind=photo|comic`

搜索按名称和标签匹配相册、集合和标签，结果中的 `path` 是相册/集合 ID；相册与标签结果可带 `tags: string[]`。标签结果使用 `smart:<tag>` 作为内部标签标识，前端统一转换到 `/tags/<tag>`。搜索条目在每次媒体库 revision 发布时预计算，查询不会递归读取完整目录树。

`kind` 与其它列表接口同义（必填），过滤全部命中：相册与集合按目录属性归属，标签按该属性下是否还有相册判断。

结果按匹配质量排序后再按 `limit` 截断：完全等于查询 > 名字以查询开头 > 名字包含查询 > 标签命中；同等质量下名字更短的排在前面。散图（"本目录媒体"）的 `name` 是归属目录路径，只有命中它自己那一段目录名才算名字命中，只命中上级目录名（路径里的同名目录）排在最后 —— 用户找的是"哪一本"，不是"哪一棵树"。

散图（"本目录媒体"）的搜索条目 `name` 是归属目录路径，并带 `virtual: true`：它的展示名与同名集合完全一致，前端据此把类型标签显示成"散图"而不是"文件夹"。

### `PUT /api/albums/:albumId/cover?file=<fileId>`

设置自定义封面。文件必须属于相册、已被本次扫描收录，且为受支持图片或视频。覆盖在每次新扫描发布前重新验证和应用，不会因重扫丢失；已移动/删除的封面记录会被忽略。

### `DELETE /api/albums/:albumId/cover`

清除自定义封面并恢复扫描器默认封面。

## 媒体、缩略图与视频

### `GET /api/media/:fileId`

发送图片或视频，支持 ETag 和 Range；视频按需经过转码和 faststart 管线。

前端视频消费使用 `/api/media/:fileId?playback=<不透明播放标识>`。每次播放切换、重试、转码后重新加载和抽帧生成新标识，同次播放的多个 Range 请求沿用同一 URL；标识用于隔离浏览器媒体缓冲。服务端仍只按文件 ID 校验权限并选择当前文件，`playback` 不选择文件版本、不传递路径或凭据，也不替代收藏、历史和活动记录中的资源 ID。直接使用不带标识的资源地址仍须重新验证 HTTP 缓存。

原图与视频的每个响应独立打开最终选择的文件，ETag、Last-Modified、Content-Length 和 Range 总长度来自该次打开的文件信息，不复用旧文件句柄或旧长度。同一路径在响应之间被覆盖、缩小或替换后，无需等待文件服务缓存过期。流在完成或中断后关闭；HEAD、304 和错误响应也释放句柄。

支持单段 `Range: bytes=start-end`、`bytes=start-` 和 `bytes=-count`。未带 `If-Range`，或其值为当前强 ETag、与 Last-Modified 精确到秒相同的 HTTP 日期时，按范围返回 `206`。`If-Range` 过期、为弱 ETag、ETag 列表、无效值或不匹配的日期时，忽略 Range 并返回完整当前文件（`200`，不带 Content-Range），即使该 Range 越界也不会返回 416。常规缓存条件先于 If-Range 判断；匹配的 If-None-Match 仍返回 304。

需要处理范围时，无效范围、空后缀或多段范围返回 `416 invalid_range`，携带 `Content-Range: bytes */<当前大小>` 和 `Cache-Control: no-store`，不带 ETag。HEAD 不传输媒体内容；不带 Range 时返回当前完整长度。

响应前确认源路径仍为普通文件；扫描后被目录或其他非普通文件替换时，图片返回 `404 media_not_found`，视频返回 `404 video_not_found`。此检查先于 ETag、Range、转码缓存选择和文件发送，不返回目录重定向或携带本地路径的 `Location`，也不因条件请求返回 304。源文件恢复后，原 ID 可继续使用。

视频派生缓存仅命中非空普通文件，不跟随缓存条目自身的链接。空文件、目录及链接不会直接发送或用于 304 协商；空缓存按需重新生成，生成失败时沿用后续 faststart 或源文件流程，不返回缓存目录重定向。目录占位及其内容保留。

浏览器原生解不了的图片格式（HEIC/HEIF/TIFF）不按原文件发送：服务端用 ffmpeg 转成 JPEG（最长边 2560）后再返回，`Content-Type` 为 `image/jpeg`，ETag 仍取源文件的 mtime+size，因此条件请求照常协商 304。转换结果按源文件 mtime+size 派生的键缓存在 `derived/converted/`，第二次访问直接命中缓存。ffmpeg 不可用或转换失败时返回 `415 unsupported_image_format`，前端显示"该图片无法显示"，不再把浏览器解不了的原文件当图片发出去。

### `GET /api/previews/:fileId?w=<像素宽度>&v=<内容版本号>`

返回按宽度等比缩放的预览图（JPEG）。`w` 缺省 1600，非数字或非正数返回 `400 invalid_preview_width`；宽度会**向上对齐**到固定档位阶梯 320 / 640 / 1280 / 1920 / 2560 / 4096。

阅读器连续模式按视口宽度展示图片。直接发原图的话，手机照片动辄 12MP / 5MB，一屏就是几 MB，整本翻下来是 GB 级流量，浏览器还要为每张原图解码出几十 MB 位图。预览图按请求宽度缩放后约 200–400KB。

源图比 `w` 还窄时直接返回原图字节（不重新编码，零画质损失）；需要缩放时输出 JPEG（q85），带 alpha 的 PNG 先压到白底再编码，避免透明区域变成黑块。HEIC/HEIF/TIFF 仍走 ffmpeg 转换路径。

响应 `Content-Type: image/jpeg`，ETag 由源文件的 mtime+size+渲染算法版本+目标档位派生；带 `If-None-Match` 命中时返回 `304`，不重复传图。条件判定在生成之前完成，冷缓存上的 304 也不必付出解码代价。预览图按源文件版本与档位分别缓存在 `derived/previews/`，可在设置页单独清理。带 `v` 且版本一致时响应 `Cache-Control: private, max-age=31536000, immutable`。

| 状态 | code                       | 含义                           |
| ---- | -------------------------- | ------------------------------ |
| 400  | `invalid_preview_width`    | `w` 不是正整数                 |
| 404  | `media_not_found`          | 源路径不存在或不再是普通文件   |
| 415  | `unsupported_image_format` | 不是受支持的图片，例如视频文件 |
| 500  | `preview_failed`           | 无法生成预览图                 |

### `GET /api/thumbs/:fileId?w=<像素宽度>&v=<内容版本号>`

返回 JPEG 渲染图。`w` 缺省 640，非数字或非正数返回 `400 invalid_render_width`；宽度会**向上对齐**到固定档位阶梯 320 / 640 / 1280 / 1920 / 2560 / 4096。视频尚无封面时返回 `404` 和 `code: video_cover_missing`。

源路径不存在或不再是普通文件时返回 `404 source_not_found`；先校验源类型，再查询内存/磁盘缓存或尝试抽帧，不将目录误报为 `video_cover_missing`。

纯 Go 解码器不支持的图片格式（HEIC/HEIF 等 iPhone 照片）优先用 ffmpeg 转换后生成缩略图；ffmpeg 不可用或转换失败时返回 `415 unsupported_format`，前端显示占位图而不是破图。

渲染图等比缩放到不超过目标宽度，不补边、不放大，因此返回的 JPEG 尺寸随源文件宽高比变化（例如 16:9 视频在 640 档返回 640×360，而不是补边后的 640×640）。前端按原始比例展示，不裁切画面。

档位阶梯是前后端共同的实现约定，不是配置项：同一张源图在各档之间宽高比一致，前端才能用 `srcset` 让浏览器按显示宽度与像素比自选档位。档位进缓存键与 ETag，因此换档就是换一份产物。

视频封面另有一层「母版」：服务端 ffmpeg 抽帧（或前端浏览器抽帧后上传）得到的原帧存为母版，母版宽 1280；各档渲染图从母版缩出，不按档位重复抽帧。母版比目标档位还窄时直接给母版，不放大。

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

`/events` 使用 SSE。排队与运行中的任务发送 `event: progress`，结束时发送一条 `event: done` 并关闭连接；事件 data 均为 `{ status, progress, etaSec, error? }`。`etaSec` 是按「已耗时 × 剩余比例」线性外推的剩余秒数估算；进度为 0、任务未开始或进度不足 0.5%（速率还不准）时为 0，表示未知；估算封顶 24 小时。没有活动任务时，按当前状态查询结果发送一条完整的 `done` 快照后关闭：磁盘缓存可用为 `cached`，原生可播放为 `not_needed`，工具不可用为 `unavailable`，需要转码但任务还没启动为 `pending`。迟到或重复订阅同样复核当前状态，不发送空对象作为终态，不因内存中缺少任务记录而误报缓存不可用。

`pending` 表示"这个视频需要转码，但转码任务还没开始"——转码由媒体请求按需触发，播放之前既没有缓存也没有在跑的任务。这不是故障：状态查询返回 `pending` 且不带 `error`，前端不应据此显示"转码失败"。缓存条目存在但无效（空文件或目录）仍报 `failed`。

任务与当前源文件大小、纳秒修改时间及转码 profile 关联；大小或修改时间变化后，查询和新订阅不沿用旧版本进度或错误，新媒体请求取消旧任务并按需启动当前版本。当前版本的有效磁盘缓存优先于内存任务状态，缓存恢复后可直接返回 `cached`。任务在启动或发布前发现源版本变化时，不发布该次产物，原任务进度流返回 `failed`，`error` 为 `video source changed`；下一次媒体请求按新版本处理。旧版本被新请求主动取消时，其原订阅仍收到取消终态。

## 收藏、历史与媒体活动

偏好文件只保存稳定资源 ID。加载时会丢弃不符合当前资源 ID 格式的记录，避免暴露本机路径。

偏好响应中的 `favorites`、`history` 以及清理响应中的 `removed` 始终为数组；没有条目时返回 `[]`，不返回 `null`。删除最后一个收藏、清空最近访问和无变化清理同样遵循此约定。

- `GET /api/prefs`、`PATCH /api/prefs`：读取或修改界面偏好。高频媒体活动不再混入偏好响应。
  `appMode` 是全局工作台模式，取值 `photo` / `comic`（缺省 `photo`），决定列表呈现哪一类相册；
  非法值返回 `400 invalid_app_mode`。两个模式互斥且完整覆盖媒体库：目录属性把媒体库分成
  照片与漫画两半，工作台一次只面对其中一半。
- `GET /api/favorites`：返回 `{ "favorites": ["<resourceId>"] }`。
- `POST /api/favorites`、`DELETE /api/favorites`：body 为 `{ "resourceId": "a_... | c_... | smart:<tag>" }`。
- `POST /api/favorites/prune`：按当前资源目录移除已失效相册/集合 ID，返回 `{ "removed": ["<resourceId>"] }`，不访问 ID 对应的文件路径；智能标签保留。资源目录尚未完成首次加载时返回 `409`，不会删除收藏。
- `GET /api/history`、`DELETE /api/history`。
- `POST /api/history`：body 为 `{ "albumId": "a_...", "name": "...", "imageCount": 42 }`。

媒体活动使用复合标识：漫画阅读为 `albumId + mediaKind=image`，视频为
`albumId + mediaKind=video + itemId`。漫画页码与每个视频的播放位置互不覆盖。
照片浏览不留进度记录，因此没有 `mediaKind=photo`。

- `GET /api/activity?albumId=<albumId>&mediaKind=image`：读取漫画阅读活动。视频查询还必须传 `itemId=<fileId>`。
- `PUT /api/activity`：幂等写入单条活动。漫画 body 为 `{ "albumId": "a_...", "mediaKind": "image", "pageIndex": 12, "pageCount": 30 }`；视频 body 为 `{ "albumId": "a_...", "mediaKind": "video", "itemId": "f_...", "positionMs": 42000, "durationMs": 120000 }`。
- `POST /api/activity/query`：body 为 `{ "items": [{ "albumId": "a_...", "mediaKind": "image" }] }`，按精确标识批量读取，返回 `{ "activities": [], "count": 0 }`。
- `PUT /api/activity/batch`：body 为 `{ "activities": [...] }`，整批校验后一次原子落盘；单批最多 10000 条。
- `DELETE /api/activity?...`：幂等删除单条；`DELETE /api/activity/all` 清空全部图片和视频活动。

相同标识下，归一化后的位置与总数均未变化时保留原 `updated`，不写盘、不推进活动版本；单条写入响应返回实际保存的记录。批量请求也会跳过这些重复项，整批没有变化时不写盘。只有成功原子落盘后才确认有效变更。

`/api/library/activity-summary`、`/api/library/dashboard` 与 `/api/library/unread` 均按漫画阅读活动判定未读：有图片的漫画相册看它的 `image` 活动，纯视频的漫画相册改以是否存在视频播放活动为准——播放过就不再计入未读，避免视频相册永久停留在未读列表。前者用于常驻导航，仪表盘用于首页，专用分页端点用于完整未读列表。

未读与在读都属于漫画工作台的概念：照片目录下的相册不记录阅读进度，因此 `kind=photo` 时三个接口的未读计数恒为 0、`inProgress` 恒为空。仪表盘的 `inProgress` 只上报漫画相册的阅读页码。

响应中 `status` 为 `in_progress` / `completed`，由服务端按实际位置派生。图片到达
`pageCount - 1` 完成；视频到达 98% 完成。`/api/progress` 不提供。

图片 `pageIndex` 表示当前视图实际展示的最末页：单页模式为当前页，双页模式为跨页
右侧页，连续模式为可见区末页。读取不存在的记录返回 `404 activity_not_found`；标识或
数值非法返回 `400 invalid_activity_identity` / `400 invalid_activity`；持久化不可用返回
`500 activity_unavailable`。前端只把明确的 `activity_not_found` 当作新记录，其他错误
不会开放自动写入，避免恢复失败时覆盖已有位置。

## 精选（照片级）

精选与相册级收藏是两份数据、两种语义：收藏标记「这一本值得留着」（相册、集合或智能标签），
精选标记「这一张值得留着」（单个媒体文件）。两者互不覆盖，也不会互相清理 ——
「清理失效收藏」不会动精选，移出精选也不会动收藏。精选单独存放在
`<cacheDir>/state/picks.json`，上限 5000 条。

精选只属于照片工作台：照片墙与精选页都是照片侧的界面，漫画那边有阅读进度与已读状态，
不需要另一套「这一张值得留着」。

- `GET /api/picks`：返回 `{ "ok": true, "picks": ["f_..."], "total": 3, "revision": 7 }`。
  `picks` 是精选的文件 ID，最近加入的排在最前面；`revision` 在每次成功写入后递增。
- `POST /api/picks/batch`：body 为 `{ "ids": ["f_..."], "action": "add" | "remove" }`，
  响应 `{ "ok": true, "updated": 2, "total": 5, "revision": 8 }`。加入是幂等的，
  移出对本来就不在精选里的条目没有影响；`updated` 是实际变化的条数。单批最多 1000 项，
  标识不是合法文件 ID 时返回 `400 invalid_picks_batch`，超过上限返回 `400 pick_limit`。
- `GET /api/picks/media?limit=60&cursor=...`：分页返回精选照片本身，跨相册。
  每项是媒体项加上 `albumId` 与 `albumName`（它属于哪本相册），并带 `picked: true`。
  文件被移出媒体库后它自然从这一页消失：精选说的是「库里的照片」，不是对磁盘路径的承诺。
  漫画相册里的文件不进这一页。

精选页的分页游标作用域里带精选自身的 `revision`：精选一变，旧的游标立即返回
`400 invalid_cursor`，客户端从第一页重取。这样新加入的照片不会把已经翻过的页顶走一格。

## 缓存与系统操作

- `GET /api/cache/stats`：返回脱敏缓存名称、占用和文件数。除总占用 `totalBytes` / `fileCount` 外，按子目录给出 `thumbs`（缩略图）、`converted`（HEIC/HEIF/TIFF 的整图转换产物）、`previews`（阅读器按宽度缩放的预览图）、`videoFaststart`、`videoTranscode` 五项细分；各子目录的 `bytes` 之和等于 `totalBytes`。子目录尚不存在时该项 `available=false`、`bytes`/`fileCount` 为 0。
- `POST /api/thumbs/cleanup`
- `POST /api/cache/clear?scope=thumbs|converted|previews|faststart|transcode|all`：统一清空入口，按 scope 删 thumbs / converted / previews / faststart / transcode 缓存中对应的一类；scope=all 同时清理五类派生缓存和视频元数据内存摘要。响应 `{ scope, thumbs?, converted?, previews?, faststart?, transcode?, totalDeleted, totalFreedBytes }`，未涉及的 scope 字段省略。删除数量与释放字节只统计磁盘文件，不包含内存摘要。
- `POST /api/cache/rebuild`：启动一次后台重建，请求体 `{ scopes: ["thumbs","previews"], previewWidth?: number }`。响应 `{ ok, jobId, reused, scopes, previewWidth }`；已有任务在跑时复用它（`reused=true`）。范围只接受 `thumbs` 与 `previews`，其它值返回 `400 invalid_rebuild_scope`，空范围返回 `400 missing_rebuild_scope`。
- `GET /api/cache/rebuild/:id`：返回重建进度快照 `{ jobId, status, scopes, total, done, failed, elapsedMs, error? }`。`status` 取 `pending` / `running` / `complete` / `cancelled` / `error`。未知 jobId 返回 `404 rebuild_not_found`。
- `GET /api/cache/rebuild/:id/events`：重建进度的 SSE 流，事件名与任务状态同名（`pending`/`running`/`complete`/`cancelled`/`error`），data 为上述快照；终态事件后连接关闭，每 15 秒发一次注释心跳。`running` 事件在任务运行期间每 500ms 推一次快照，进度条不会停在起点；终态事件带最终计数。
- `DELETE /api/cache/rebuild/:id`：取消正在进行的重建。任务已结束时返回 `{ ok: true, alreadyDone: true }`。

重建把渲染图与预览图提前算好，免得清空之后每次打开页面都要在请求里现算。
缩略图档按用途取：相册封面额外生成最小档（320），其余照片只生成 640；预览图按
`previewWidth`（缺省 1280，对齐到档位阶梯）生成。视频封面要靠 ffmpeg 抽帧，不参与
批量重建。重建只覆盖派生缓存，不会碰 `state/`。
- `POST /api/fs/open`：本机接口，body 为 `{ "id": "<resourceId>" }`。执行前按当前媒体根重新校验路径；根、集合和相册必须仍为目录，文件必须仍为普通文件。
- `GET /api/admin/fs/open?path=<configuredPath>&allowConfig=1`：设置页专用，仅允许打开已配置路径且只接受回环请求。

系统打开操作有副作用，前端不自动重试请求；配置目录打开的 GET 同样不缓存响应。

`POST /api/fs/open` 拒绝扫描后出现在根内路径中的符号链接或 Windows junction，`allowConfig` 查询参数不能豁免该资源校验。主要错误如下：

| 状态 | code                                         | 含义                                                              |
| ---- | -------------------------------------------- | ----------------------------------------------------------------- |
| 400  | `invalid_resource_id`                        | 缺少 ID 或请求体非法                                              |
| 403  | `os_open_disabled` / `local_access_required` | 系统打开未开启或请求来自远程                                      |
| 404  | `resource_not_found`                         | ID 无效、已过期、路径不在当前根中、含链接、资源不可用或类型已变化 |
| 500  | `os_open_failed`                             | 校验或系统打开依赖不可用，或系统打开执行失败                      |

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

| 状态 | code                        | 含义                                  |
| ---- | --------------------------- | ------------------------------------- |
| 400  | `invalid_directory_request` | 请求体非法、路径含 NUL 或目标不是目录 |
| 403  | `directory_access_denied`   | 服务进程没有读取目录的权限            |
| 404  | `directory_not_found`       | 目录不存在或离线                      |
| 500  | `directory_read_failed`     | 目录读取失败，错误信息不包含完整路径  |

浏览、翻页和取消不修改文件或配置。确认选择后，前端把返回的完整路径提交给现有 `PUT /api/config`；媒体根沿用停止输入 450ms 后保存，缓存与静态目录立即保存并保留需重启提示。

### 媒体目录离线与初始设置

服务启动和配置重载只校验运行参数，媒体根暂时离线或 mediaRoots: [] 不阻止访问设置页。显式 PUT 修改 mediaRoots 时校验每个非空目录存在且为目录；空数组表示主动清空配置。只修改其他设置时不检查旧媒体根是否在线。空白路径会被忽略，不会解析到进程工作目录。扫描仍要求本轮所有根可访问；失败保留上次已发布快照，不将离线目录当作删除。不支持部分根扫描发布。


### 浏览列表查询

`GET /api/library/overview` 在服务端筛选、排序后分页，首页、集合和标签页共用。

- `kind=photo|comic` 必填；`parent` 指定根/集合，`tag` 指定标签，两者互斥，均省略时查询首页各根直属节点与智能标签（首页隐藏虚拟相册）。标签放查询参数，由框架解码一次，字面 `+`、`%xx` 由客户端编码保留。
- `view=all|album|collection|smart`，默认 `all`；`q` 匹配标题和标签；`year=1900..2099|other` 按标题提取年份；`minImageCount` 非负且只约束相册。
- `sort=name|count|added|recent|viewed` 默认 `name`，依次为自然名称、数量降序、业务日期降序、修改时间降序、相册访问时间降序。同值按名称及稳定 ID 排列。
- `limit` 沿用分页默认值与上限，`cursor` 是不透明游标，绑定全部查询条件、库 revision，以及 `viewed` 排序使用的历史快照。变更后返回现有 `invalid_cursor` 或 `stale_cursor`，客户端清空分页链重取首屏。非法筛选返回 `400 invalid_library_query`。
- 响应 `{ok:true,page:{revision,items,total,nextCursor?,counts,scopeCounts,years,series,imageTotal,videoTotal,latestModified,completedCount}}`。`items` 是 `{kind:"album"|"collection",node:节点摘要}` 或 `{kind:"smart",tag:标签摘要}`；`counts` 在应用所有其他筛选但尚未应用 `view` 时计数；`scopeCounts`、`years`、`series` 和媒体总量来自未筛选的完整作用域，不随已加载页数变化。
- `years` 每项包含年份、直属项数、图片/视频总量、代表入口与封面；`series` 包含作品 ID、名称、卷数与封面；`completedCount` 是漫画标签全部成员中的已读数。响应不携带本机绝对路径。

### 跨相册照片流

`GET /api/library/media-feed` 返回跨相册的照片序列：每张照片带它来自哪本相册，用户不必先认准是哪一本才能看到那些照片。

- `kind=photo|comic` 必填，与其它列表接口同义。
- `scope` 必填，决定从哪里取材：
  - `year` —— 取某个年份下各相册的照片。`year` 必填，取 `1900..2099` 或 `other`（没有年份的那一桶）。年份口径与 `overview` 的年份分组一致：取直属节点名里第一处 `19xx` / `20xx`；年份分组里的集合会展开成它内部的所有相册，集合里的散图（"本目录媒体"）也算在其中。
  - `collection` —— 取某个集合内部所有相册的照片，`parent` 必填且必须是集合 ID。
  - `recent` —— 取最近加入的几本相册里的照片。
  - `random` —— 取随机几本相册里的照片。
- `limit` 沿用分页默认值与上限，`cursor` 是不透明游标，绑定取材条件与库 revision。`year` 与 `collection` 分页；`recent` 与 `random` 一次返回整批，不分页。
- 响应 `{ok:true,page:{revision,items,total,nextCursor?,albums}}`。`items` 是媒体字段加上 `albumId` / `albumName`；`albums` 是这一页涉及的相册 `{id,name,count}`。
- `recent` 与 `random` 会把几本相册的照片交错排布：连着看一本相册的头几张，墙上就只剩一种口味。
- 非法取材条件返回 `400 invalid_media_feed`；集合 ID 不存在返回 `404 resource_not_found`，类型不对返回 `400 invalid_resource_kind`。响应不携带本机绝对路径。
