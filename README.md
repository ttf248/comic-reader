# Local Gallery · 本地画廊

Local Gallery 是一款在本机运行的照片、漫画与视频画廊。Go 后端直接读取配置的目录，浏览器提供界面；应用状态保存在本地 JSON 文件中，不需要数据库。媒体分析与语义检索都在本机执行，语义检索模型需首次单独下载。

协作规则见 [AGENTS.md](./AGENTS.md)。

## 核心功能

| 工作区 | 主要功能 |
| --- | --- |
| 照片 | 多目录合并为媒体库；按相册、集合、标签、年份和 GPS 地点浏览；中文语义搜索与以图搜图；照片墙、大图预览、并排对比、精选、收藏、最近浏览。 |
| 漫画 | 独立作品列表；单页、连续、双页与 RTL 阅读；缩放、旋转、目录、阅读进度恢复、未读列表与最近阅读。 |
| 后台任务 | 扫描进度与取消；EXIF/GPS、OCR、人脸分析和语义向量的全量或增量任务；任务中心支持按序启动全部已就绪模块、暂停、继续、失败项重试、重启恢复与每日计划，并链接到本机模型/缓存路径及占用统计。任务记录失败图片的相对路径。 |
| 本机 AI | Chinese-CLIP 中文语义搜索和图片相似检索；RapidOCR 识别文字并在图片详情查看；YuNet + SFace 检测人脸、生成本地特征并查找相似照片。 |
| 视频与媒体 | 浏览器原生播放和 Range 请求；可选 FFmpeg 提供视频封面、元数据、faststart、H.264/AAC 转码及 HEIC/HEIF/TIFF 转换。 |
| 本机管理 | 多媒体根目录、缓存清理、状态备份与恢复、明暗主题、键盘与触摸操作。照片级「精选」与相册级「收藏」分开保存。 |

照片与漫画是两套隔离的工作区。每个媒体根目录需指定照片或漫画类型；漫画阅读进度不会混入照片浏览历史。

## 第一次安装与运行

### 使用发布包

当前主线是 Go + React v2 架构。下载发布包时选择 v2.x 对应的系统与架构；v1.x 属于旧版 Python/PyInstaller 架构，不适用于当前配置。若 [发布页](https://github.com/ttf248/local-gallery/releases) 尚无 v2.x 包，请按下面的源码方式构建。

1. 下载并解压与你的操作系统和处理器架构对应的 local-gallery-v2.x 压缩包。
2. 复制配置样例并编辑媒体目录。照片和漫画目录都可以配置多个；暂时不添加目录时可使用 mediaRoots: []，之后在设置页添加。

   ~~~powershell
   # Windows
   Copy-Item config.example.yaml config.yaml
   ~~~

   ~~~sh
   # macOS / Linux
   cp config.example.yaml config.yaml
   ~~~

   配置示例：

   ~~~yaml
   mediaRoots:
     - path: "D:/Photos"
       kind: photo
     - path: "E:/Comics"
       kind: comic
   host: "127.0.0.1"
   port: 8080
   accessMode: local
   cacheDir: ".local-gallery"
   staticDir: "dist"
   ~~~

   路径请替换为本机实际目录，并建议使用正斜杠。Windows 可写 `D:/Photos`；macOS/Linux 可写 `/Users/you/Pictures` 或 `/home/you/Pictures`。`cacheDir` 和 `staticDir` 的相对路径以启动目录为准。

3. 从解压目录启动。

   ~~~powershell
   # Windows
   .\local-gallery.exe --config .\config.yaml
   ~~~

   ~~~sh
   # macOS / Linux
   ./local-gallery --config ./config.yaml
   ~~~

4. 浏览器打开 http://127.0.0.1:8080。等待已配置目录完成扫描后即可浏览。若 `mediaRoots` 为空，先进入「设置」添加照片或漫画目录；目录变更后会自动扫描。按 Ctrl+C 停止服务。

使用发布包浏览照片、漫画和视频不需要 Go、Node.js、Python 或数据库。语义搜索需要额外安装 Python 环境并下载模型；FFmpeg 属于可选增强组件。

### 从源码构建

适用于当前主线和需要修改代码的用户。准备：

- Go 1.24 或更新的兼容版本；
- Node.js 20 或更新版本，包含 npm；
- PowerShell 7（用于仓库构建脚本）；
- Python 3.11 仅在启用语义搜索时需要。

先在仓库根目录创建本机配置：

~~~powershell
Copy-Item backend/config.example.yaml backend/config.yaml
~~~

编辑 backend/config.yaml 中的 mediaRoots，填入真实目录和类型。源码构建并启动时，进程工作目录是 backend/，将 staticDir 设为 ../frontend/dist。

Windows 在仓库根目录执行：

~~~powershell
.\build.bat
.\start.bat
~~~

macOS / Linux 在仓库根目录执行：

~~~powershell
pwsh -NoProfile -File scripts/build.ps1
cd backend
../bin/local-gallery --config config.yaml
~~~

服务默认监听 127.0.0.1:8080，后端同时托管 frontend/dist。构建和源码目录一键运行说明见 [构建与发布](./docs/RELEASE.md)。

### 开发模式

开发模式需要两个终端。首次安装前端依赖一次：

~~~powershell
Set-Location frontend
npm ci
~~~

终端一启动后端：

~~~powershell
Set-Location backend
go run ./cmd/server --config config.yaml
~~~

终端二启动 Vite：

~~~powershell
Set-Location frontend
npm run dev
~~~

打开 http://localhost:5173。Vite 会把 /api 请求代理到 http://127.0.0.1:8080。开发模式不需要设置可用的 staticDir。

## 可选功能安装

### 本机 AI 安装（一次执行）

首次安装会准备 Chinese-CLIP、中文 OCR 与人脸检测/相似检索所需的 Python 运行环境和权重。需要 Python 3.11、PowerShell 7 与网络；Windows 使用项目独立虚拟环境和 CUDA 12.6 版 PyTorch，无可用 NVIDIA GPU 时仍可用 CPU。OCR 和人脸分析使用本机 ONNX Runtime CPU 推理。

源码目录从仓库根目录运行一次：

~~~powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File backend/aiworker/setup.ps1
~~~

发布包从解压目录运行一次：

~~~powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File aiworker/setup.ps1
~~~

脚本安装 RapidOCR、ONNX Runtime、OpenCV，并下载/校验 Chinese-CLIP、YuNet 和 SFace 权重；最后实际运行 OCR 识别、YuNet 检测与 SFace 特征提取检查。安装完成后重启 Local Gallery，在「任务中心」运行「文字识别」或「人脸识别」的全量任务；之后可用增量任务处理新增或变更图片。图片详情会展示识别文字、人脸框，并可按人脸查找相似照片。识别组件见 [RapidOCR 安装与用法](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/install/)；人脸权重固定来自 [OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) 和 [SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)。

Python 虚拟环境位于 Worker 目录的 `.venv/`，模型按配置保存在 `<cacheDir>/derived/ai/models/`：

~~~text
clip_cn_vit-b-16.pt
face/face_detection_yunet_2023mar.onnx
face/face_recognition_sface_2021dec.onnx
~~~

默认 `cacheDir` 是进程工作目录下的 `.local-gallery`。权重不会放进系统 Python 或 `site-packages`，也不包含在发布压缩包中。Chinese-CLIP 权重约 753 MB；OCR 模型随 RapidOCR 安装；两个人脸模型合计约 37 MB。

macOS / Linux 可在安装 Python 3.11 和 PowerShell 7 后运行同一安装脚本；脚本会建立 Worker 独立环境并使用 PyTorch 默认平台 wheel。若要单独重下或校验权重，可运行 `backend/aiworker/download-model.ps1`（发布包路径为 `aiworker/download-model.ps1`）。

### FFmpeg 媒体增强

FFmpeg / ffprobe 用于视频封面与元数据、部分视频转码和特殊图片格式转换。源码目录的 Windows 用户可从仓库根目录运行：

~~~powershell
pwsh -NoProfile -File scripts/install-ffmpeg.ps1
~~~

其他平台可安装系统 FFmpeg，或在 config.yaml 中设置 ffmpegPath。没有 FFmpeg 时，照片、漫画和浏览器原生支持的视频仍可使用；需要服务端转码的媒体可能无法播放。

## 配置与本地数据

- 配置文件是 YAML。源码开发默认读取 `backend/config.yaml`；发布包读取启动目录中的 `config.yaml`。CLI 仅用 `--config` 选择配置文件。
- `mediaRoots` 每项包含 `path` 与 `kind`，`kind` 为 `photo` 或 `comic`。可留空后从设置页添加。目录路径按进程工作目录解析。
- 默认缓存目录是进程工作目录下的 `.local-gallery/`。`state/` 保存任务、偏好、精选、收藏与活动等 JSON 状态；`derived/` 保存缩略图、向量索引与可重新生成的派生数据。
- 默认地址为 `127.0.0.1:8080`、`accessMode: local`，只供本机访问。需要局域网访问时，按 [配置样例](./backend/config.example.yaml) 设置 `accessMode: lan` 与强随机令牌；不要将服务暴露到互联网或不可信网络。
- 源码构建与发布包的 `staticDir` 不同：源码从 `backend/` 启动时使用 `../frontend/dist`；发布包从包根目录启动时使用 `dist`。
- 配置字段、默认值和可热更新项见 [配置样例](./backend/config.example.yaml) 与 [API 文档](./docs/API.md)。架构和持久化布局见 [架构文档](./docs/ARCHITECTURE.md)。

## 当前能力边界

- 这是单用户本地画廊，不包含账号系统、云端同步、在线分享、协作或数据库。
- 只扫描配置的文件夹，不导入 ZIP/RAR 等压缩包。
- 语义检索与人脸相似检索目前面向照片；人脸功能只按本机特征查找相似照片，不识别或推断真实姓名。
- GPS 地点相册按照片坐标在本机生成，不调用在线地图或地理编码服务。
- 发布包是便携压缩包，不安装系统服务或配置登录自启；需要手动启动程序并保持进程运行。
- 发布包会附带本机 AI Worker、依赖清单和一键安装脚本，但不会打包 Python 虚拟环境或模型权重。基本浏览无需 Python；启用 OCR、人脸分析或语义搜索前需运行上文安装脚本。

## 开发验证

以下命令适用于完整源码仓库；发布包用户按前文的发布包步骤启动。

| 工作目录 | 命令 | 用途 |
| --- | --- | --- |
| backend/ | go test ./... | 后端单元与集成测试 |
| backend/ | go test ./tests/integration -v | HTTP 集成主链路 |
| backend/ | go vet ./... | 后端静态检查 |
| backend/aiworker/ | python test_worker.py | Worker 权重校验、OOM 回退与 CPU 状态测试 |
| frontend/ | npm run lint | 前端静态检查 |
| frontend/ | npm run test | Vitest 单元与组件测试 |
| frontend/ | npm run build | TypeScript 检查与生产构建 |
| frontend/ | npm run test:e2e | 独立临时媒体库的全栈浏览器测试 |
| 仓库根 | pwsh -NoProfile -File scripts/build.ps1 | 全栈构建 |
| 仓库根 | pwsh -NoProfile -File scripts/package-release.ps1 -Version 2.0.0 -TargetOS windows -TargetArch amd64 | 生成 Windows 发布包 |

E2E 首次运行前，在 frontend/ 执行 npx playwright install chromium。测试会生成独立临时媒体与配置，不读取个人媒体库；只读文档改动不需要新增业务测试。

## 项目结构与文档

~~~text
backend/
  cmd/server/         Go 服务入口与依赖装配
  aiworker/           本机语义搜索 Worker、依赖与模型安装脚本
  internal/           配置、资源索引、媒体服务、API 与 JSON 存储
frontend/
  src/                React 页面、API、hooks、store 与界面组件
  tests/e2e/          Playwright 全栈测试
scripts/              构建、发布、FFmpeg 安装与开发工具
docs/                 API、架构、快捷键、设计与发布文档
~~~

| 文档 | 用途 |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | 协作边界、修改规则、验证与提交要求 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 模块边界、媒体管线、任务与持久化 |
| [docs/API.md](./docs/API.md) | HTTP、SSE、字段与错误码 |
| [docs/SHORTCUTS.md](./docs/SHORTCUTS.md) | 键盘快捷键 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 界面目标、设计权限与视觉验证 |
| [docs/RELEASE.md](./docs/RELEASE.md) | 构建、发布包、手动 CI 与正式发布 |

## 使用范围与许可

项目当前定位为单用户本地媒体工具，按目录读取照片、漫画和视频。不提供在线分享或协作，也不解析压缩包。仓库目前没有单独的 LICENSE 文件，再分发与商业使用授权尚未在仓库中明确，因此当前发布包也不会附带许可证文件。
