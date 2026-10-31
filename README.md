# Local Gallery · 本地画廊

> 本地图像 / 视频画廊。Go + React，单进程单端口，离线可用。

> 协作与自动化规则见 [AGENTS.md](./AGENTS.md)；构建、推送和发布流程见 [docs/RELEASE.md](./docs/RELEASE.md)。

指一下硬盘上的文件夹，按 `R` 随机翻一卷，hover 看大图，按 `?` 翻出所有快捷键。
剩下的，让它自己跑。

---

## TL;DR

- **零客户端**：浏览器即用，无桌面安装
- **多根目录**：`mediaRoots[]` 数组，所有根下的子目录合并成一个全局库
- **三态标签**：`[xxx]` 从目录名自动提取 → 智能合集
- **视频管线**：ffmpeg 抽帧 / ffprobe 元数据 / faststart 修 moov / **冷门编码自动转 H.264+AAC**
- **缩略图**：LRU + 磁盘双层缓存，mtime 失效
- **画廊**：单张 / 连续滚动 / 双张并排（支持 RTL），4 套 fit；移动端横向滑动翻页，放大后可拖拽平移
- **主题**：light / dark / system + 6 套强调色
- **跨设备持久化**：收藏、最近、图片阅读/视频播放活动、设置走服务端 JSON
- **无障碍与触摸适配**：尊重系统减少动态效果设置，移动端使用导航抽屉，阅读器支持横向滑动翻页
- **单进程单端口部署**：Go 后端托管前端静态资源，一个端口一把梭
- **手动验证发布**：手动 CI 覆盖三平台测试，手动 Release 生成跨平台发布包

---

## 能力清单

### 库与扫描

- 多个媒体根目录并入一个全局库
- 异步扫描 + SSE 实时进度，可取消
- 扫描完成后显示脱敏告警详情，帮助定位不可读目录、跳过符号链接和媒体元数据问题
- worker pool（`min(8, NumCPU)`），大库不卡
- 扫描结果内存 + 磁盘缓存，结果树与资源 ID 索引作为同一 revision 原子发布
- manifest、目录子节点、全局相册、相册媒体与标签使用 revision 游标分页；收藏/最近浏览可按 ID 批量解析摘要
- 相册业务日期由后端统一解析，固定按“拍摄元数据 → 严格目录日期 → 修改时间”降级，并返回时间来源
- **扫描排除规则**：跳过隐藏目录 + 系统白名单 + 用户 glob 模式（`node_modules` / `temp*` 等）

### 缩略图

- LRU（默认 500 项）+ 磁盘双层缓存
- mtime 失效：源文件改了，缓存自动重生成
- 缩略图尺寸和编码版本参与缓存键；浏览器重新验证稳定媒体 URL，修改尺寸后不继续命中旧图
- 视频封面：服务端 ffmpeg `-ss` before `-i` 抽帧，浏览器零内存负担
- 浏览器抽帧回退使用媒体 Range 按需读取，抽帧后释放解码器；上传成功沿用原封面资源 URL 重新验证，失败可重试，离开页面取消探测、抽帧和上传
- 视频和混合媒体缩略图的播放与封面重试各自使用独立按钮，支持键盘操作，重试不会打开播放器
- HEIC/HEIF 直出（Safari 16+ 原生解码）

### 视频

- 原生 `<video>` 播放，Range / ETag 协商
- ffprobe 元数据，列表卡片渲染时就有时长/分辨率/码率
- faststart：自动 remux，moov 跑到 mdat 前面，"0:00 卡死"问题自动消失
- **自动转码**：AV1 / HEVC / ProRes / 未知编码 → H.264 + AAC 喂给浏览器
- 冷门编码转码状态可在列表卡片上看到（转码中 X% / 已缓存 / 转码失败）
- 转码 singleflight 去重 + 全局并发限流 + 可取消
- **缓存清理**：设置页按 thumbs / faststart / transcode 三个 scope 独立清理 + 一键全清（`POST /api/cache/clear?scope=…`）

### 画廊

- 3 种显示模式：单张 / 连续滚动 / 双张并排
- 4 种图片适配：适应 / 按宽 / 按高 / 原始（按 `F` 循环）
- 缩放 / 旋转 / 90° 翻转 / 全屏
- 单页阅读器支持触摸横向滑动翻页，放大后用拖拽平移且不会误触翻页
- 跳到指定页（`G` + 页码），底部页码滑块拖拽时浮出 5 张缩略图条
- 幻灯片自动播放
- 进度恢复或保存失败时持续提示并提供重试；恢复失败期间暂停自动保存，保护原记录

### 视频播放器

- 原生 `<video controls>` + 增强快捷键
- `Space/K` 播放暂停，`←/→` 跳 5 秒，`↑/↓` 音量 ±10%，`M` 静音
- 视频元数据（时长 / 尺寸 / 编码 / 码率）随列表渲染，无需等加载

### 主题与外观

- light / dark / system 三态
- 6 套强调色：graphite / indigo / rose / forest / ochre / plum
- CSS 变量驱动，主题切换一次 reflow 不重渲组件树

### 导航与搜索

- 主页：年份时间线（海报式 4:5 卡）+ 全库网格；网格和列表仅渲染视口附近卡片
- 相册媒体网格接近已加载边界时自动翻页，拖到远处也会逐页补齐；分页失败保留已加载内容并提供重试
- 小屏使用可关闭的响应式导航抽屉，不压缩主内容区域
- 悬停预览：240×300 放大卡，含进度条 / 上次阅读 / 张数
- 全局搜索（`/` 聚焦）模糊匹配 name / 标签
- 全局最小图数 filter（`≥N` 控件）隐藏杂物相册
- 年份筛选、视图切换（grid / list）、三种排序（名称 / 张数 / 最近）
- 随机一本（`R` / 侧边栏"随机"按钮）：服务端直接从摘要索引抽取，不为常驻导航下载全库
- 首页仪表盘：服务端一次返回未读总数、6 本未读预览与在读摘要；完整未读列表仅在 `U` 页面按需加载
- 排序：按名称 / 张数 / 最近改 / 最近看
- **未读列表**（`U`）：服务端直接筛选未读相册并分页传输，side badge 显计数 + 随机未读快捷键
- `N` / `P` 跨卷翻页
- 阅读器通过相册资源 ID（`/gallery?path=a_...`）定位并按需加载媒体；标题和最近访问摘要采用真实相册名称、图片总数，视频数量不会覆盖图片总数

### 持久化

- 收藏：跨设备，按稳定资源 ID 保存，`POST /api/favorites` 幂等
- 收藏、历史及失效收藏清理结果的空列表统一返回 `[]`，无失效项时清理明确提示零项成功
- 最近：LRU，去重，最多 10 条
- 最近阅读区分加载、读取失败、资源失效与筛选为空；读取失败可重试，后台刷新失败保留已加载记录
- 打开相册写入最近访问后立即刷新相关列表与“最近看”排序；媒体分页不重复记录同一次打开
- 媒体活动：图片保存 0-based 页码，每个视频独立恢复毫秒位置；批量标记只触发一次原子落盘
- 偏好：原子写（tmp + rename），崩溃不丢

### 资源安全

- 公共 API 只接受 `r_` / `a_` / `c_` / `f_` 稳定资源 ID
- 绝对路径只存在于后端进程内部；库快照、URL、日志和浏览器 store 均不暴露
- ID 解析后仍由 `path_safety` 校验必须位于配置根目录内
- 每次资源请求重新检查根内路径组件，拒绝扫描后被替换为符号链接或 Windows junction 的目录
- 配置与系统打开接口仅允许回环地址访问，越权请求一律拒绝

---

## 30 秒上手

```bash
# 1. 拉代码
git clone <repo> && cd local-gallery

# 2. 写一份配置（任意本地媒体根目录）
cd backend
cp config.example.yaml config.yaml
# 编辑 config.yaml，至少把 mediaRoots 改成你机器上的路径

# 3. 装前端依赖
cd ../frontend && npm install

# 4. 跑起来
# 后端
cd ../backend && go run ./cmd/server      # 默认 :8080
# 前端（开发模式，HMR）
cd ../frontend && npm run dev              # 默认 :5173，反向代理到 :8080
```

打开 `http://localhost:5173`，`Ctrl+S` 扫描，按 `R` 随机翻一卷。

> 全栈开发首选 VSCode → 运行和调试 → **"全栈复合调试"**。详见 `.vscode/launch.json`。

### 生产部署

Windows 源码目录支持双击根目录的 `build.bat` 构建，再双击 `start.bat` 启动：

1. 构建需要 PATH 中可用的 Go 1.24+、Node.js 20+（含 npm）和 PowerShell 7（`pwsh`）。
2. `build.bat` 调用 `scripts/build.ps1`，执行 `npm ci`、前端构建和 Windows 本机架构后端构建，输出 `frontend/dist/` 与 `bin/local-gallery.exe`。
3. 首次运行前，将 `backend/config.example.yaml` 复制为 `backend/config.yaml`，设置实际存在的 `mediaRoots`，并设置 `staticDir: "../frontend/dist"`。已有配置直接检查这两项，无需覆盖。
4. `start.bat` 从 `backend/` 工作目录直接运行上述二进制，读取 `config.yaml`；启动不需要 Go、Node.js 或 PowerShell，也不会自动构建。默认访问 `http://127.0.0.1:8080`，按 `Ctrl+C` 停止。

两个 BAT 都可从任意工作目录调用；构建结束或启动失败时会暂停显示结果。命令行及自动化调用可加 `--no-pause`，退出码会保留。配置、缓存和构建产物不入仓。完整说明见 [构建与发布](./docs/RELEASE.md)。

手动构建运行（同样先配置 `staticDir: "../frontend/dist"`，并从 `backend/` 启动）：

```bash
cd frontend && npm run build              # 产物在 frontend/dist
cd ../backend && go build -o ../bin/server ./cmd/server
../bin/server                             # 单端口同时托管 API + 静态资源
```

生产发布包、版本线和手动验证流程见 [`docs/RELEASE.md`](./docs/RELEASE.md)。当前 Go + React 架构从 `v2.0.0` 开始；GitHub 上已有的 `v1.x` Release 属于旧 Python 架构，仅作为历史版本保留。

---

## 配置

所有运行时参数集中在 `backend/config.yaml`（默认相对后端 CWD 查找）。完整字段见 [`backend/config.example.yaml`](./backend/config.example.yaml)。

| 字段                        | 说明                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `mediaRoots`                | 媒体根目录数组，可设 `[]` 后从设置页配置；离线目录不阻止启动                            |
| `host` / `port`             | 监听地址 / 端口                                                           |
| `accessMode`                | `local` 仅回环访问（默认）；`lan` 开启可信家庭网络令牌保护         |
| `accessToken`               | LAN 模式必填，32-256 个无空白字符；只用于换取 HttpOnly 会话       |
| `cacheDir`                  | 应用工作目录；`state/` 保存状态，`derived/` 保存可清缓存，默认 `./.local-gallery/`；旧顶层文件不读取、不移动；修改需重启 |
| `thumbSizeW` / `thumbSizeH` | 缩略图尺寸                                                                |
| `thumbCacheSize`            | LRU 内存缓存项数                                                          |
| `cacheMaxAgeDays`           | 磁盘缓存保留天数                                                          |
| `cacheMaxSizeMB`            | 派生缓存容量软上限，默认 10240 MiB；0 不限容量；启动及每小时按年龄和容量清理 |
| `ffmpegPath`                | ffmpeg / ffprobe 路径，留空则自动探测 `bin/ffmpeg/<os>/<arch>/`；修改需重启 |
| `allowOsOpen`               | 是否允许 `/api/fs/open` 在系统资源管理器里打开                            |
| `staticDir`                 | 前端构建产物目录（生产单端口托管用）                                      |
| `skipHidden`                | 是否跳过以 `.` 开头的隐藏目录（默认 true）                                |
| `excludePatterns`           | 扫描时跳过的目录/文件名 glob 模式列表，每行一条；按 basename 匹配任意深度 |
| `systemFiles`               | 在内置白名单（Thumbs.db / desktop.ini / .DS_Store）之上追加跳过的系统文件 |

启动参数只保留 `--config <yaml>`；`staticDir` 也从配置文件读取。**不支持环境变量或其他 CLI 覆盖**。
配置项可在网页 `/settings` → 「服务端」里改，部分字段热生效（见 [`docs/API.md`](./docs/API.md)「配置项」一节）。

开发版只接受当前 API 与持久化 schema：所有 HTTP 失败响应固定为 `{ code, message, details? }`；扫描缓存 schema 不匹配时会隔离原文件并以空缓存启动。

---

## ffmpeg · 可选但强烈推荐

视频元数据、抽帧封面、faststart 修 moov、自动转码，全部依赖 `ffmpeg` / `ffprobe`。
**没有 ffmpeg 也能用**——只是视频封面/元数据会回退到浏览器抽帧，冷门编码视频播不了。

仓库自带绿色安装脚本（不动 `PATH`、不需管理员）：

```powershell
# Windows PowerShell：默认从 gyan.dev 拉 ffmpeg-release-essentials.zip
pwsh -File scripts/install-ffmpeg.ps1

# 强制重装
pwsh -File scripts/install-ffmpeg.ps1 -Force

# 换源 / 自定义安装目录
pwsh -File scripts/install-ffmpeg.ps1 -Url <zip-url> -TargetDir D:\tools\ffmpeg
```

默认安装到 `bin/ffmpeg/windows/amd64/`，后端启动时自动探测，**不用改配置**。脚本幂等，缺啥装啥。
macOS / Linux 走 `bin/ffmpeg/<os>/<arch>/` 同形目录，安装脚本后续补。

### 没有 ffmpeg 会怎样

| 能力                           | 有 ffmpeg           | 无 ffmpeg                       |
| ------------------------------ | ------------------- | ------------------------------- |
| 缩略图（图片）                 | ✅                  | ✅                              |
| 视频封面                       | ffmpeg 抽帧，~339ms | 浏览器 Range 抽帧，超时可重试 |
| 视频元数据                     | ffprobe，~100ms     | 等 `<video>` 加载完，秒级延迟   |
| 视频播放                       | ✅                  | ✅                              |
| 冷门编码（AV1/HEVC/ProRes）    | 自动转 H.264+AAC    | 浏览器播不了就播不了            |
| Faststart（moov 在末尾的 MP4） | 自动 remux          | 浏览器可能 0:00 卡死            |

---

## 项目结构

```
local-gallery/
├── build.bat / start.bat    # Windows 一键构建 / 运行构建产物
├── backend/                # Go + Fiber
│   ├── cmd/server/         # 入口（flag + YAML 配置装配 + 服务装配）
│   ├── internal/
│   │   ├── config/         # YAML 加载 + 校验 + 热更新
│   │   ├── models/         # 领域模型（Album / Collection / SmartCollection / Prefs）
│   │   ├── services/       # 业务（scanner / thumbnail / scan_runner / video_*）
│   │   ├── store/          # JSON 偏好/媒体活动持久化（原子写）
│   │   ├── handlers/       # Fiber 路由处理
│   │   └── middleware/     # logger / recover / path_safety
│   └── tests/integration/  # 端到端 HTTP 测试
├── frontend/               # React 18 + Vite + TypeScript
│   └── src/
│       ├── api/            # fetch + SSE 封装，端点模块
│       ├── hooks/          # useKeyboard / useScanSSE / useTheme / useFavorites…
│       ├── store/          # zustand（ui / gallery / search）
│       ├── routes/         # 按需加载的 Home / Album / 标签 / Gallery / Recents / Favorites / Unread / Settings
│       ├── components/     # album / gallery / layout / home / common
│       └── utils/          # shortcuts / path / storage / format / albumGrouping / libraryCard
├── docs/                   # 架构 / API / 快捷键 / 全功能清单
├── scripts/                # dev / build / package / publish / monitor / install-ffmpeg
├── .github/workflows/      # CI 与 v2 发布工作流
└── .vscode/                # launch / tasks / settings / extensions
```

---

## 文档导航

| 文档                                           | 看什么                                   |
| ---------------------------------------------- | ---------------------------------------- |
| [README.md](./README.md)                       | 30 秒上手、能力清单、配置                |
| [docs/FEATURES.md](./docs/FEATURES.md)         | 全功能清单（按域分组，每项指向代码位置） |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 系统设计、模块划分、数据流、性能         |
| [docs/API.md](./docs/API.md)                   | HTTP 接口手册                            |
| [docs/SHORTCUTS.md](./docs/SHORTCUTS.md)       | 快捷键全集（含视频播放器）               |
| [docs/RELEASE.md](./docs/RELEASE.md)            | 手动验证、推送、版本线与发布包             |

`?` 在应用里随时唤起可搜索的帮助浮层。

---

## 开发

| 操作     | 命令                                                        |
| -------- | ----------------------------------------------------------- |
| 启动后端 | `cd backend && go run ./cmd/server`                         |
| 启动前端 | `cd frontend && npm run dev`                                |
| 后端测试 | `cd backend && go test ./...`                               |
| 前端单测 | `cd frontend && npm run test`                               |
| 集成测试 | `cd backend && go test ./tests/integration -v`              |
| e2e      | `cd frontend && npm run test:e2e` 或 `scripts/test-e2e.ps1` |
| 全栈启动 | VSCode → "全栈复合调试"                         |
| 全栈构建 | `scripts/build.ps1` 或 VSCode 任务 `build: all`             |
| 提交已暂存文件并推送 | `pwsh -File scripts/publish.ps1 -Message "feat: ..."`      |

**改动业务逻辑必须同步改测试**——后端 handler / service / middleware → `go test`；前端组件 / hook / store → Vitest；跨层主链路 → integration / e2e。

---

## 命名历史

| 时期            | 项目名                    | Go module                     | 默认缓存目录      | 查看器路由 |
| --------------- | ------------------------- | ----------------------------- | ----------------- | ---------- |
| v1（最初）      | comic-reader              | `tianlongxiang/comic-reader`  | `.comic-reader/`  | `/reader`  |
| v2（2026 早期） | image-viewer / 图像浏览器 | `tianlongxiang/comic-reader`  | `.image-viewer/`  | `/viewer`  |
| v3（当前）      | local-gallery / 本地画廊  | `tianlongxiang/local-gallery` | `.local-gallery/` | `/gallery` |

配置仅保留当前 `mediaRoots[]` 契约，不维护已废弃的单数根目录别名。

---

## 不做什么

诚实声明：

- ✅ 手动 CI 验证 Windows / macOS / Linux；手动 Release 生成发布包
- ❌ 不存数据库（偏好走服务端 JSON 原子写）
- ❌ 不引入微服务 / 消息队列
- ❌ 不做用户系统（单用户本地工具）
- ❌ 不支持在线分享 / 协作
- ❌ 不解析 ZIP / RAR 漫画包（只读目录）

---

## 许可

仅供个人学习和非商业用途。

---

```
$ cat .signature
Mavis · Local Gallery · 本地画廊
```
