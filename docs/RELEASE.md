# 构建与发布

Windows 开发、构建和发布包入口在根 [README.md](../README.md)；本文件只保留跨平台验证与正式发布步骤。

## 本地开发

Windows 首次准备依赖：

```bat
scripts\setup-dev.bat
```

设置 `backend\config.yaml` 后，`build.bat` 构建前后端，`start.bat` 启动服务。Go 1.24+、Node.js 20+ 和 npm 需已安装。

macOS / Linux 直接用 Go 与 npm：

```sh
(cd backend && go mod download)
(cd frontend && npm ci)
(cd frontend && npm run build)
mkdir -p bin
(cd backend && go build -o ../bin/local-gallery ./cmd/server)
(cd backend && ../bin/local-gallery --config config.yaml)
```

E2E 首次运行前，在 `frontend/` 安装 Chromium：

```sh
cd frontend
npx playwright install chromium
npm run test:e2e
```

测试入口 `scripts/test-e2e.mjs` 会创建临时媒体库、构建并启动隔离服务，结束后清理临时进程和目录。Windows 也可从仓库根目录运行 `scripts\test-e2e.bat --audit` 或 `scripts\test-e2e.bat --crash`。

## CI

CI 与 Release 只通过 GitHub Actions 的 `workflow_dispatch` 手动启动。CI 覆盖 Windows、macOS、Linux 的后端测试、前端 lint、单元测试和 E2E；Linux 另跑 Go race 检查并上传验证包。

如需提交推送，先按项目规则暂存当前任务文件，再准备多行中文提交说明文件：

```bat
scripts\publish.bat commit-message.txt
```

脚本只提交已暂存文件，默认运行构建、后端测试、前端 lint 和单元测试，然后推送当前分支。文档改动可加 `--skip-validation`。脚本不会自动运行 GitHub Actions。

查看指定提交的工作流：

```bat
scripts\watch-github-actions.bat <commit-sha>
```

需要先安装并登录 GitHub CLI（`gh`）。

## 正式发布

当前发布线为 Go + React v2；历史 v1 发布保持不变。发布前手动运行 CI，在 `docs/release-notes/vX.Y.Z.md` 写中文说明，确认远端没有同名标签，再推送注释标签：

```sh
git tag -a v2.0.0 -m "发布 v2.0.0"
git push github v2.0.0
```

在 GitHub Actions 页面手动运行 Release 并选择该标签。工作流构建一次前端，交叉编译 Linux、Windows、macOS 的 amd64 / arm64 包，生成校验和并创建或更新 Release。

Windows 本地生成发布包：

```bat
scripts\package-release.bat 2.0.0 windows amd64
```

发布包包含可运行程序、`dist/`、示例配置、文档和 `aiworker/` 源码；不包含 Python 虚拟环境和模型。Windows 用户运行 `aiworker\setup.bat` 安装 AI 环境。macOS / Linux 需安装 Python 3.11 与平台对应依赖，再运行 Worker。

版本号由发布标签注入后端和前端。不要为普通提交修改版本，也不要提交 `frontend/dist`、`bin/`、发布包或运行时缓存。

\n