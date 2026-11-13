# Local Gallery · 本地画廊

Local Gallery 是一款在本机运行的照片、漫画与视频画廊。Go 后端直接读取配置的目录，浏览器提供界面；应用状态保存在本地 JSON 文件中，不需要数据库。媒体分析与语义检索都在本机执行，语义检索模型需首次单独下载。

协作规则见 [AGENTS.md](./AGENTS.md)。

## 核心功能

| 工作区 | 主要功能 |
| --- | --- |
| 照片 | 多目录合并为媒体库；按相册、集合、标签、年份和 GPS 地点浏览，足迹页正文右栏是一块把照片坐标聚成网格的地图，左边是一条按真实时间比例铺开的时间轴（一格一个月的张数，行程是格子上方的小钉）与一段段行程；中文语义搜索与以图搜图；照片墙、大图预览、并排对比、精选、收藏、最近浏览。 |
| 漫画 | 独立作品列表；单页、连续、双页与 RTL 阅读；缩放、旋转、目录、阅读进度恢复、未读列表与最近阅读。 |
| 后台任务 | 扫描进度与取消；EXIF/GPS、OCR、人脸分析和语义向量的全量或增量任务；任务中心支持按序启动全部已就绪模块、始终查看等待队列、筛选与清理历史记录、暂停、继续、失败项重试、重启恢复与每日计划，并在同一页给出本机存储：派生缓存占用与清理、各分析模块的模型权重与产物、相对路径与本机绝对路径。模型任务默认强制使用 GPU，可切换为 CPU；GPU 不可用或推理失败时会将原因写入任务记录。启动前先给出本次要处理的张数与预计耗时（增量与全量并排对比，耗时按历史任务速度估算）。任务记录可展开查看该次任务自己的产物目录与占用，失败图片给出相对路径。 |
| 本机 AI | Chinese-CLIP 中文语义搜索和图片相似检索；RapidOCR 识别文字、支持 OCR 关键词搜索，并可与相册、年份、GPS、人物、收藏和精选条件组合；YuNet + SFace 检测人脸、生成本地特征、查找相似照片并建立可改名/合并/拆分/隐藏的人物候选相册。人物分析默认关闭，须在任务中心显式启用。 |
| 视频与媒体 | 浏览器原生播放和 Range 请求；可选 FFmpeg 提供视频封面、元数据、faststart、H.264/AAC 转码及 HEIC/HEIF/TIFF 转换。 |
| 本机管理 | 多媒体根目录、派生缓存清理与重建、状态备份与恢复、明暗主题、键盘与触摸操作。照片级「精选」与相册级「收藏」分开保存。 |

照片与漫画是两套隔离的工作区。每个媒体根目录需指定照片或漫画类型；漫画阅读进度不会混入照片浏览历史。

## 第一次安装与运行

### 使用发布包

当前主线是 Go + React v2 架构。下载发布包时选择 v2.x 对应的系统与架构；v1.x 属于旧版 Python/PyInstaller 架构，不适用于当前配置。若 [发布页](https://github.com/ttf248/local-gallery/releases) 尚无 v2.x 包，请按下面的源码方式构建。

1. 下载并解压与你的操作系统和处理器架构对应的 local-gallery-v2.x 压缩包。
2. 复制配置样例并编辑媒体目录。照片和漫画目录都可以配置多个；暂时不添加目录时可使用 mediaRoots: []，之后在设置页添加。

   ~~~bat
    REM Windows
    copy /Y config.example.yaml config.yaml >NUL
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

### 从源码开发

适用于要修改代码的用户。安装 Git、Go 1.24+、Node.js 20+（包含 npm）后克隆仓库。Windows 首次运行准备脚本：

在仓库根目录首次运行准备脚本：

~~~bat
scripts\setup-dev.bat
~~~

脚本会创建 `backend/config.yaml`（已有配置不会覆盖），并准备 Go 和前端依赖。macOS / Linux 用户执行 `cd backend && go mod download`、`cd frontend && npm ci`，并从 `backend/config.example.yaml` 复制配置。打开 `backend/config.yaml`，将 `mediaRoots` 改为本机目录；也可以设为 `[]`，启动后从设置页添加。

开发时打开两个终端：

~~~sh
# 终端一
cd backend
go run ./cmd/server --config config.yaml
~~~

~~~sh
# 终端二
cd frontend
npm run dev
~~~

浏览器访问 http://localhost:5173。Vite 会将 `/api` 转发到后端 `127.0.0.1:8080`。开发模式不需要设置 `staticDir`。

### 构建并运行

需要单进程运行时，在 `backend/config.yaml` 中将 `staticDir` 设为 `../frontend/dist`。Windows 在仓库根目录运行：

~~~bat
build.bat
start.bat
~~~

macOS / Linux 在仓库根目录运行：

~~~sh
npm --prefix frontend run build
mkdir -p bin
(cd backend && go build -o ../bin/local-gallery ./cmd/server)
(cd backend && ../bin/local-gallery --config config.yaml)
~~~

服务默认监听 `127.0.0.1:8080`。构建与发布细节见 [构建与发布](./docs/RELEASE.md)。

## 可选功能安装

### 本机 AI 安装（一次执行）

Windows 一键安装需要 Python 3.11、NVIDIA 驱动和网络。脚本会创建项目虚拟环境、安装 CUDA 12.6 版 PyTorch、OCR 与人脸识别依赖、下载模型并执行推理检查。模型下载默认经过 `http://127.0.0.1:7897`：

~~~bat
backend\aiworker\setup.bat
~~~

发布包用户在解压目录运行：

~~~bat
aiworker\setup.bat
~~~

需要改代理端口时，编辑两个 BAT 脚本中的 `http_proxy`、`https_proxy`。脚本校验 Chinese-CLIP、YuNet 和 SFace 权重的 SHA256，并实际检查 OCR、人脸推理。安装后重启应用，在「任务中心」运行相应任务；人物分析需先启用。模型来源：[OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) 和 [SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)。

Python 虚拟环境位于 Worker 目录的 `.venv/`，模型按配置保存在 `<cacheDir>/derived/ai/models/`：

~~~text
clip_cn_vit-b-16.pt
face/face_detection_yunet_2023mar.onnx
face/face_recognition_sface_2021dec.onnx
~~~

默认 `cacheDir` 是进程工作目录下的 `.local-gallery`。虚拟环境位于 Worker 目录的 `.venv/`；模型保存在 `<cacheDir>/derived/ai/models/`，不包含在发布压缩包中。Chinese-CLIP 权重约 753 MB；OCR 模型随 RapidOCR 安装。

macOS / Linux 用户自行用 Python 3.11 创建 `.venv` 并安装平台对应依赖，然后在 `backend/aiworker/` 中运行 `python download_models.py`。Linux 可使用 CUDA 版 PyTorch，macOS 使用 CPU 版。Windows 单独重下模型可运行 `backend/aiworker/download-model.bat`。

### FFmpeg 媒体增强

FFmpeg / ffprobe 用于视频封面与元数据、部分视频转码和特殊图片格式转换。源码目录的 Windows 用户可从仓库根目录运行：

~~~bat
scripts\install-ffmpeg.bat
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
- 语义检索、人脸相似检索与人物相册目前面向照片；人物分组只是本机相似度候选，不识别或推断真实姓名，需要用户确认和纠错。
- 足迹页在本机将照片坐标匹配到省、市、区县边界，不调用在线地图或地理编码服务；地图上的点位只以约 20 公里一格的聚合下发，不还原到单张照片的坐标。边界数据来源与使用限制见 [架构文档](./docs/ARCHITECTURE.md#exifgps-与离线地点地图)。
- 发布包是便携压缩包，不安装系统服务或配置登录自启；需要手动启动程序并保持进程运行。
- 发布包会附带本机 AI Worker、依赖清单和一键安装脚本，但不会打包 Python 虚拟环境或模型权重。基本浏览无需 Python；启用 OCR、人脸分析或语义搜索前需运行上文安装脚本。

## 开发验证

以下命令适用于完整源码仓库；发布包用户按前文的发布包步骤启动。

| 工作目录 | 命令 | 用途 |
| --- | --- | --- |
| backend/ | go test ./... | 后端单元与集成测试 |
| backend/ | go test ./tests/integration -v | HTTP 集成主链路 |
| backend/ | go vet ./... | 后端静态检查 |
| backend/ | go test ./internal/services -run TestOCRSearchQualityEvaluation -v | 可复现 OCR 中文空格、断行、标点与近似误识评测 |
| backend/ | go test ./internal/services -run '^$' -bench '^BenchmarkVectorIndexSearch100K$' -benchtime=31x -benchmem | 10 万向量 Top-K 延迟与分配基准 |
| backend/aiworker/ | python test_worker.py | Worker 权重校验、模型缓存、OOM 处理、强制 GPU 不回退与 CPU 状态测试 |
| backend/aiworker/ | `python evaluate_quality.py --model-dir <cacheDir>/derived/ai/models --device gpu --profile-device-switches --output <ignored-path>.json` | 确定性中文语义/OCR 质量集与设备切换基准；输出写仓库忽略路径，不读取用户媒体 |
| frontend/ | npm run lint | 前端静态检查 |
| frontend/ | npm run test | Vitest 单元与组件测试 |
| frontend/ | npm run build | TypeScript 检查与生产构建 |
| frontend/ | npm run test:e2e | 独立临时媒体库的全栈浏览器测试 |
| 仓库根 | `build.bat` | Windows 全栈构建 |
| 仓库根 | `scripts/package-release.bat 2.0.0 windows amd64` | 生成 Windows 发布包 |

E2E 首次运行前，在 frontend/ 执行 npx playwright install chromium。测试会生成独立临时媒体与配置，不读取个人媒体库；只读文档改动不需要新增业务测试。

## 项目结构与文档

~~~text
backend/
  cmd/server/         Go 服务入口与依赖装配
  aiworker/           本机 AI Worker、依赖与环境安装脚本
  internal/           配置、资源索引、媒体服务、API 与 JSON 存储
frontend/
  src/                React 页面、API、hooks、store 与界面组件
  tests/e2e/          Playwright 全栈测试
scripts/              BAT 入口与跨平台 E2E 辅助脚本
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
