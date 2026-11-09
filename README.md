# Local Gallery · 本地画廊

本地照片、漫画与视频浏览器，Go + React，单进程单端口，离线可用。协作规则见 [AGENTS.md](./AGENTS.md)。

## 当前能力

- 多个媒体根合并为一个库，保留目录集合，从目录名提取标签，支持年份、搜索、收藏与最近浏览；列表支持多选、批量收藏及漫画已读/未读操作。
- 可取消的后台扫描与 SSE 进度，媒体根配置变更后自动扫描；服务端筛选排序、按需分页和虚拟网格支撑大库，扫描失败保留上次完整结果。
- 全局工作台模式：侧栏品牌区下方切换「照片 / 漫画」，两套菜单完全隔离——照片工作台只列照片目录的相册，用「浏览 / 收藏 / 最近」的说法；漫画工作台只列漫画目录的相册，用「继续阅读 / 未读 / 最近阅读」。模式进 URL 路径（`/photo/…` 与 `/comic/…`），切模式是普通导航，前进后退能跨模式、深链可直接分享；服务端记住上次用的是哪一侧，决定从根路径进来时落到哪边。
- 目录级的两种浏览方式：照片目录的相册进入按真实宽高比排布的照片墙，点开是沉浸式大图预览（缩放、拖动、全屏、键盘）；漫画目录的相册进入阅读器，支持单页、连续、双页并排、RTL、适配、缩放、旋转、全屏、触摸翻页、目录与进度恢复。
- 内容属性按目录设置且互斥：每个媒体根只能是照片或漫画，目录下的相册与集合一并继承。阅读进度、未读与「读完」只属于漫画，照片这边不留浏览进度。
- 两个工作台各成一套：首页首屏专区不同（照片是「接着看 / 最近加入 / 随手看看」，漫画是「继续阅读 / 未读」），索引维度不同（照片按年份，漫画按作品），封面画幅不同（照片方形、漫画竖版），色调不同（照片冷、漫画暖），措辞与计数单位也不同（照片说「张 / 本 / 浏览」，漫画说「页 / 卷 / 阅读」），菜单与按钮则完全隔离——照片侧没有「未读 / 已读完」，漫画侧没有「最近浏览」。
- 视频原生播放与 Range；可选 ffmpeg 提供封面、元数据、faststart、按需 H.264 + AAC 转码及特殊图片格式转换。
- 缩略图、预览图和视频派生缓存分层存储，可分别清理；收藏、最近、阅读/播放活动与偏好通过服务端 JSON 持久化；图片进度串行合并并跳过重复落盘，设置页可导出备份、预览并按类别覆盖恢复。
- 界面采用中性灰阶的视觉表达：首页阅读与发现区、照片卡片、相册摘要、分组设置和暗场阅读器共用一套无彩灰阶，照片是页面上唯一的彩色，仅品牌标记与页眉眉标用琥珀点缀（工作台模式会给品牌点缀换成冷/暖两套色调）；支持明暗/跟随系统主题、键盘与触摸操作。主页面按 `R` 随机打开一本、`Ctrl+S` 扫描、`?` 查看当前场景的快捷键。

## 开发启动

需要 Go 1.24+、Node.js 20+（含 npm）；仓库脚本与 E2E 使用 PowerShell 7。首选 VSCode「运行和调试」中的“全栈复合调试”，入口见 [.vscode/launch.json](./.vscode/launch.json)。

首次配置与安装，在仓库根目录执行：

```powershell
Copy-Item backend/config.example.yaml backend/config.yaml
# 编辑 mediaRoots，填入本机媒体目录；也可设为 [] 后从设置页添加
cd frontend
npm ci
```

分别在两个终端启动，以下均从仓库根目录开始：

```powershell
# 终端一：后端
cd backend
go run ./cmd/server
```

```powershell
# 终端二：前端
cd frontend
npm run dev
```

打开 `http://localhost:5173`。Vite 将 `/api` 代理到 `http://127.0.0.1:8080`，同时改写 Host 与 Origin；无需额外跨域配置。

## 构建与运行

Windows 源码目录支持 `build.bat` 构建、`start.bat` 运行。先准备上述配置，并设置 `staticDir: "../frontend/dist"`。首次运行前在 `frontend/` 执行 `npm ci`；此后 `start.bat` 每次启动都会重建前后端，构建失败时不会启动已有二进制。两个入口可双击或从命令行调用，自动化可加 `--no-pause`。

VSCode「运行和调试」里的“运行本机最新构建”也会在启动前构建前后端；“后端: Go (Fiber)”和“全栈复合调试”直接以 Go 调试器运行源码。

其他平台可在仓库根目录执行 `pwsh -File scripts/build.ps1`，同样使用 `staticDir: "../frontend/dist"`，从 `backend/` 运行生成的 `../bin/local-gallery`。Windows 产物带 `.exe` 后缀。默认访问 `http://127.0.0.1:8080`。

发布包用户：在解压目录复制 `config.example.yaml` 为 `config.yaml`，设置媒体根并保留 `staticDir: "dist"`，从该目录运行 `local-gallery`（Windows 为 `local-gallery.exe`）。运行发布包无需 Go、Node.js 或 PowerShell。

跨平台打包、手动 CI 与 Release 流程见 [构建与发布](./docs/RELEASE.md)。构建产物与运行时配置不入仓。

## 配置

字段、配置示例与默认值说明集中在 [backend/config.example.yaml](./backend/config.example.yaml)，内置默认值以 `config.Default()` 为准；热更新规则见 [API 配置契约](./docs/API.md#健康与配置)。

- 运行参数来自 YAML，CLI 只支持 `--config <yaml>` 选择文件，不支持环境变量或其他参数覆盖。相对媒体、缓存与静态目录均相对进程 CWD 解析。
- `mediaRoots` 是唯一媒体根字段，每个条目是 `{ path, kind }`：`kind` 为 `photo` 或 `comic`，两者互斥，决定该目录归入哪个工作台。可设空数组；目录暂时离线仍可启动并访问设置页，扫描不会发布部分根的结果。
- `cacheDir` 默认是 CWD 下 `.local-gallery/`，`state/` 保存持久状态，`derived/` 保存可重建缓存；“清空缓存”保留状态。存储布局见 [架构文档](./docs/ARCHITECTURE.md#配置与持久化)。
- `/settings` 的“服务端”可修改配置，仅本机可管理。默认 `127.0.0.1:8080`、`accessMode: local`；可信家庭网络访问需配置 `lan` 与强令牌，浏览器通过 HttpOnly 会话认证。
- `host`、`port`、`cacheDir`、`staticDir` 与 `ffmpegPath` 修改后重启；配置页会显示重启提示。源码运行与发布包的 `staticDir` 布局不同，按上一节设置。

前端默认同源访问；自定义 API 基址时按 [frontend/.env.example](./frontend/.env.example) 设置构建期 `VITE_API_BASE`，它不覆盖后端 YAML。

### 可选依赖

ffmpeg / ffprobe 提供视频增强能力及 HEIC/HEIF/TIFF 转换。Windows 可从仓库根目录安装到 `bin/ffmpeg/windows/amd64/`，后端自动探测，不修改 PATH：

```powershell
pwsh -File scripts/install-ffmpeg.ps1
# 可选参数：-Force 强制重装；-Url 指定压缩包；-TargetDir 指定安装位置
```

其他平台或自定义安装位置需设置 `ffmpegPath` 为可执行文件路径。工具缺失时图片浏览与原生可播放视频仍可用，视频封面回退浏览器抽帧；需转码的视频和特殊图片格式可能无法显示。

## 开发验证

| 工作目录    | 命令                             | 用途                                   |
| ----------- | -------------------------------- | -------------------------------------- |
| `backend/`  | `go test ./...`                  | 后端单元与集成测试                     |
| `backend/`  | `go test ./tests/integration -v` | 仅 HTTP 集成主链路                     |
| `backend/`  | `go vet ./...`                   | 后端静态检查                           |
| `frontend/` | `npm run lint`                   | 前端静态检查                           |
| `frontend/` | `npm run test`                   | Vitest 单元/组件测试                   |
| `frontend/` | `npm run build`                  | TypeScript 检查与生产构建              |
| `frontend/` | `npm run test:e2e`               | 使用独立临时库启动真实全栈 E2E         |
| 仓库根      | `pwsh -File scripts/build.ps1`   | 全栈构建；也可使用 VSCode `build: all` |
| 仓库根      | VSCode「运行本机最新构建」或 Windows `start.bat` | 构建本机前后端最新代码并启动 |

首次跑 E2E 需在 `frontend/` 执行 `npx playwright install chromium`。E2E 自动选择端口、生成媒体与构建产物，结束清理临时服务，不读取个人媒体库。用例按浏览、阅读器、设置和状态拆分，共享临时服务时顺序运行。业务改动按协作规则同步相应测试；纯文档改动检查链接、引用与格式。

前端重设计可调整现有布局、组件与视觉 token，设计权限、质量要求及审计/截图/崩溃探针统一见 [设计文档](./docs/DESIGN.md)；现有尺寸、列数和布局测试随方案演进。性能基准只在显式优化任务运行，方法见架构文档。

## 项目结构与文档

```text
backend/
  cmd/server/         Go 入口与服务装配
  internal/           config、pathutil、models、middleware、handlers、services、store
  tests/integration/  真实 HTTP 路由测试
frontend/
  src/                api、hooks、store、routes、components、styles、utils
  scripts/            布局/对比度审计、截图、崩溃探针
  tests/e2e/          Playwright 全栈用例
scripts/              开发、构建、E2E、ffmpeg 安装与手动发布工具
.vscode/              现有调试、任务与编辑器配置
.github/workflows/    仅手动触发的 CI 与 Release
```

后续 AI 默认只需阅读 `AGENTS.md` 与本页，再按任务选读下表；无需逐份加载。依赖版本看 `backend/go.mod` 与 `frontend/package.json`，配置字段看 YAML 样例。代码与测试用于确认当前行为，现有视觉方案可以按设计目标重做。

| 文档                                           | 何时阅读                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| [AGENTS.md](./AGENTS.md)                       | 开始工作：边界、修改规则、验证与提交要求             |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 定位模块，修改扫描、资源索引、媒体管线、状态或持久化 |
| [docs/API.md](./docs/API.md)                   | 修改或对接 HTTP/SSE 契约、字段和错误码               |
| [docs/SHORTCUTS.md](./docs/SHORTCUTS.md)       | 修改快捷键、菜单、弹窗和输入控件的键盘行为           |
| [docs/DESIGN.md](./docs/DESIGN.md)             | 修改界面：设计自主权、质量要求、验证与未完成事项     |
| [docs/RELEASE.md](./docs/RELEASE.md)           | 构建、推送、手动验证与正式发布                       |
| [docs/release-notes/](./docs/release-notes/)   | 查询对应版本的发布/迁移记录；不作为当前规则或待办    |

每类信息只维护一份完整说明。已完成工作与历史实验通过 `git log` 查询，开放界面问题集中在设计文档末尾。

## 使用范围与许可

当前为单用户本地工具，媒体按目录读取，不解析 ZIP/RAR，不提供在线分享或协作。仅供个人学习和非商业用途。
