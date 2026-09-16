# 功能清单

> 本文只描述当前实现。HTTP 字段与状态码以 [API.md](./API.md) 为准，数据流与模块边界见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 媒体库

| 能力     | 当前行为                                           | 主要实现                            |
| -------- | -------------------------------------------------- | ----------------------------------- |
| 多根目录 | `mediaRoots[]` 中的目录合并成一个库                | `config.Config`、`services.Scanner` |
| 异步扫描 | `POST /api/scans` 启动；活动任务自动复用           | `services.AsyncScanRunner`          |
| 实时进度 | 每个 SSE 客户端独立订阅，慢客户端不阻塞扫描        | `handlers.AsyncScanEventsHandler`   |
| 可取消   | context 传入目录扫描；取消结果不发布               | `Scanner.ScanWithContext`           |
| 扫描排除 | 隐藏目录、系统文件和 basename glob                 | `services.ExcludeConfig`            |
| 层级识别 | 纯媒体目录为相册；混合目录保留集合和“本目录媒体”   | `Scanner.scanDirectoryTree`         |
| 自然排序 | 文件和目录按数字片段排序（`2` 在 `10` 前）         | `naturalLess`                       |
| 扫描告警 | 不可读目录、元数据失败和符号链接不会静默丢失，并在 manifest/设置页展示脱敏详情 | `ScanResult.warnings`、`ScanWarnings` |
| 智能合集 | 从目录名提取标签并聚合                             | `services.BuildSmartCollections`    |
| 快照缓存 | 版本化相对引用、原子替换、深拷贝；根集合变化时失效 | `services.ScanResultCache`          |
| 大库分页 | 预计算目录/相册/媒体/标签顺序及节点映射，游标绑定 revision | `services.libraryPageIndex`         |

## 资源与安全

| 能力         | 当前行为                                           | 主要实现                                           |
| ------------ | -------------------------------------------------- | -------------------------------------------------- |
| 稳定 ID      | 根、相册、集合、文件使用 `r_` / `a_` / `c_` / `f_` | `services.ResourceCatalog`                         |
| 公共数据脱敏 | 媒体库分页、搜索、元数据响应不含绝对路径          | `ResourceCatalog`、handlers                         |
| 路径安全     | ID 解析后仍检查目标位于当前媒体根内                | `middleware.ResourceParam`、`PathSafetyMiddleware` |
| 本机管理     | 配置、系统打开、转码清理由回环中间件保护           | `middleware.LoopbackOnly`                          |
| 日志脱敏     | 根目录只记录 basename，缓存和工具只记录能力状态    | `cmd/server`、`middleware.Logger`                  |
| 访问门禁     | 回环/IP/Host/Origin 分层校验；LAN 强令牌换短会话 | `middleware.AccessGate`                            |
| 默认监听     | 默认绑定 `127.0.0.1:8080`                          | `config.Default`                                   |

## 缩略图与媒体

| 能力         | 当前行为                                        | 主要实现                                     |
| ------------ | ----------------------------------------------- | -------------------------------------------- |
| 图片缩略图   | 内存 LRU + JPEG 磁盘缓存，mtime 参与失效        | `services.ThumbnailService`                  |
| 视频封面     | 优先 ffmpeg 抽帧；不可用时浏览器 canvas 回填    | `VideoCoverExtractor`、`useVideoCover`       |
| 图片发送     | ETag、304、24 小时浏览器缓存                    | `handlers.ImageHandler`                      |
| 统一媒体路由 | `GET /api/media/:fileId` 按白名单分派图片或视频 | `handlers.MediaHandler`                      |
| 元数据       | 图片尺寸/checksum；视频 ffprobe 元数据          | `ImageInfoHandler`、`VideoInfoHandler`       |
| 缓存管理     | 统计、过期清理，以及按 scope 的统一缓存清空      | `handlers/cache.go`                           |

## 视频

| 能力           | 当前行为                                       | 主要实现                           |
| -------------- | ---------------------------------------------- | ---------------------------------- |
| 原生播放       | 支持 Range、ETag 和常见 MIME                   | `handlers.VideoHandler`            |
| faststart      | 非 faststart MP4 使用 ffmpeg copy-remux 并缓存 | `services.VideoFaststartService`   |
| 按需转码       | AV1/HEVC/ProRes 等按需转 H.264 + AAC           | `services.TranscodeService`        |
| 并发控制       | 同文件 singleflight，全局有界转码              | `TranscodeService.Resolve`         |
| 进度与取消     | 状态查询、SSE 和取消接口均使用文件 ID          | `handlers/transcode.go`            |
| 无 ffmpeg 降级 | 回退原文件和浏览器封面，不影响图片浏览         | 各视频 service 的 `Available` 分支 |

## 浏览与交互

| 能力       | 当前行为                                     | 主要实现                                           |
| ---------- | -------------------------------------------- | -------------------------------------------------- |
| 首页       | 年份时间线、窗口化网格/列表、筛选、排序和随机 | `routes/Home.tsx`、`components/home/HomeHeroes.tsx`、`components/album/AlbumGrid.tsx` |
| 相册       | 集合下钻、智能合集、混合媒体虚拟网格、封面选择和属性查看 | `routes/Album.tsx`、`MixedMediaThumbnailGrid`       |
| 画廊       | 单张、连续、双张、RTL、缩放、旋转、全屏      | `routes/Gallery.tsx`、`components/gallery`         |
| 视频播放器 | 原生 controls 与播放、跳转、音量、静音快捷键 | `VideoPlayer.tsx`                                  |
| 搜索       | 名称、标签模糊搜索；`/` 聚焦                 | `GlobalSearch.tsx`                         |
| 主题       | light/dark/system 和六套强调色               | `useTheme`、`themeStore`                   |
| 动效与触摸 | 尊重系统减少动态效果设置；触摸设备直接显示关键操作 | `global.css`、`useReducedMotion`、各卡片组件 |
| 键盘       | 阅读、导航、显示模式和帮助快捷键             | [SHORTCUTS.md](./SHORTCUTS.md)             |

## 用户数据

| 能力     | 当前行为                               | 主要实现                         |
| -------- | -------------------------------------- | -------------------------------- |
| 收藏     | 添加幂等、删除、清理失效项             | `PrefsStore`、favorites handlers |
| 最近     | 去重 LRU，最多十条                     | history handlers                 |
| 媒体活动 | 图片页码与视频毫秒位置分键恢复，批量原子写 | activity handlers / ActivityStore |
| UI 偏好  | 服务端 JSON 与浏览器本地偏好按用途分离 | prefs API、Zustand stores        |
| 原子写   | 临时文件完成后 rename，避免半写文件    | `store.PrefsStore`               |

## 配置与部署

| 能力       | 当前行为                                   | 主要实现                          |
| ---------- | ------------------------------------------ | --------------------------------- |
| 单一配置源 | `config.yaml`；命令行只保留 `--config`     | `config.Manager`、`cmd/server`    |
| 网页设置   | 回环请求可读写配置，返回重启提示           | `handlers.Config*`                |
| 单端口生产 | Fiber 托管 `staticDir` 并提供 SPA fallback | `cmd/server`                      |
| 开发代理   | Vite 把 `/api` 代理到 Go 后端              | `frontend/vite.config.ts`         |
| 调试入口   | 四个独立入口和一个复合入口                 | `.vscode/launch.json`             |
| 构建       | Go 二进制和 Vite 静态产物不入仓            | `scripts/build.ps1`、`.gitignore` |

## 验证

| 层级         | 命令                              |
| ------------ | --------------------------------- |
| 后端         | `cd backend && go test ./...`     |
| 后端静态检查 | `cd backend && go vet ./...`      |
| 前端静态检查 | `cd frontend && npm run lint`     |
| 前端单测     | `cd frontend && npm run test`     |
| 前端构建     | `cd frontend && npm run build`    |
| 全栈 e2e     | `cd frontend && npm run test:e2e` |
