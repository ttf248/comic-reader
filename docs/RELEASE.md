# 构建与发布

## Windows 源码目录一键运行

根目录 `build.bat` 复用 `scripts/build.ps1`，安装锁定的前端依赖、构建前端，再编译 Windows 本机架构的后端。构建需要 Go 1.24+、Node.js 20+（含 npm）和 PowerShell 7，均从 PATH 查找。

```powershell
.\build.bat
.\start.bat
```

构建产物为 `bin/local-gallery.exe` 与 `frontend/dist/`。首次启动前复制 `backend/config.example.yaml` 为 `backend/config.yaml`，填写实际媒体目录 `mediaRoots`，并将 `staticDir` 设为 `"../frontend/dist"`。脚本不会覆盖已有配置。

`start.bat` 检查二进制、前端入口和配置文件后，以 `backend/` 为工作目录执行 `../bin/local-gallery.exe --config config.yaml`，不调用编译器或开发服务器。相对媒体路径、`cacheDir` 和 `staticDir` 均相对该工作目录解析；默认状态和缓存存放在 `backend/.local-gallery/`。启动只需要构建产物和有效配置，视频增强功能仍按配置使用 ffmpeg / ffprobe。

默认访问 `http://127.0.0.1:8080`；修改监听地址或端口后使用配置中的地址。服务保持前台运行，按 `Ctrl+C` 停止。两个 BAT 均可从其他工作目录调用，包含空格或中文的仓库路径受支持。构建结束及启动失败时暂停，供双击运行查看结果；自动化使用 `--no-pause`，失败会返回非零退出码。

VSCode 的 `build: all` 任务在 Windows 上调用 `build.bat --no-pause`，生成相同的启动产物。VSCode 的“运行已构建版本”入口直接运行二进制；“调试服务测试”入口调试 services 包，完整后端回归使用 `go test ./...`。发布压缩包仍使用包内 `staticDir: "dist"` 布局，与源码目录运行方式区分。

## 发布线

GitHub 上已有的 `v1.0.0`～`v1.9.0` 是旧 Python/PyInstaller 架构的历史版本，保持只读，不再用当前代码重建或覆盖这些 Release。

当前 `main` 是 Go + React 架构，首个正式版本从 `v2.0.0` 开始。版本号遵循 SemVer：

- `v2.x.y`：当前架构的正式版本；
- `v2.x.y-rc.n`：候选版本，GitHub Release 会标记为 prerelease；
- 破坏性架构或配置契约变化提升主版本号。

分支推送、PR 和标签推送均不触发构建或发布。CI 与 Release 只保留 `workflow_dispatch` 手动入口，CNB 只同步代码。

## 手动验证与推送

在 GitHub Actions 页面选择 CI，指定分支后手动运行。验证覆盖 Windows、macOS 和 Linux 的后端测试、前端 lint、单元测试与真实全栈 E2E；Linux 额外运行 Go race 检查并上传保留 7 天的验证包。本地 Windows 未安装 C 编译器时不运行 race 检查。

本地 E2E 首次运行需要安装浏览器：

```powershell
cd frontend
npx playwright install chromium
npm run test:e2e
```

E2E 脚本自动构建、生成临时测试媒体、使用空闲端口启动服务，并在结束时清理临时进程与目录。需要 PowerShell 7，不依赖正在运行的开发服务，也不读取用户媒体库。

提交推送脚本只处理已暂存文件；非琐碎改动使用包含背景、关键改动、验证方式和影响范围的多行中文提交说明：

```powershell
git add <本次任务的文件>
pwsh -File scripts/publish.ps1 -Message $message
```

默认运行构建、后端测试、前端 lint 与单元测试后提交并推送当前分支。不自动暂存其他文件，不自动触发或等待 Actions；文档改动可使用 `-SkipValidation`。远端拒绝推送时保留本地提交，不强推。手动启动 CI 后，可单独监控：

```powershell
$sha = (git rev-parse HEAD).Trim()
pwsh -File scripts/watch-github-actions.ps1 -CommitSha $sha
```

## 正式发布

发布前先手动运行 CI 并确认通过，在 `docs/release-notes/vX.Y.Z.md` 写中文发布说明，检查远端无同名标签，然后创建并推送带注释的 `v2.*` 标签。标签需要被推送到 GitHub，若本地 `origin` 是 CNB 镜像，请使用已配置认证的 GitHub 远端推送标签：

```powershell
git tag -a v2.0.0 -m "发布 v2.0.0"
# 如果本地还没有 GitHub 远端，只需配置一次：
git remote add github https://github.com/ttf248/local-gallery.git
git push github v2.0.0
```

推送标签后，在 GitHub Actions 页面手动运行 `Release`，填写这个已存在的 `v2.x.y` 标签。发布工作流会：

1. 校验标签只属于当前 Go + React 的 `v2` 发布线；
2. 构建前端一次，并把同一份 `dist` 复用到所有平台包；
3. 使用 `CGO_ENABLED=0` 交叉编译 Linux、Windows 和 macOS；
4. 生成 `linux-amd64`、`linux-arm64`、`windows-amd64`、`darwin-amd64`、`darwin-arm64` 五种包；
5. 创建或幂等更新 GitHub Release，并上传 `SHA256SUMS`。

每个压缩包包含：

- `local-gallery` 或 `local-gallery.exe`；
- `dist/` 前端静态资源；
- `config.example.yaml`；
- `README.md`。

这是“单端口可运行包”，不是把前端资源硬编码进 Go 二进制：生产配置中的 `staticDir: "dist"` 与包内目录保持一致，便于用户替换前端资源、排查问题和保持后端构建简单。当前架构仍然是单进程，不引入数据库、消息队列或反向代理。

本地生成同样的发布包：

```powershell
pwsh -File scripts/package-release.ps1 `
  -Version 2.0.0 `
  -TargetOS windows `
  -TargetArch amd64
```

如果前端已经由 CI 或本地步骤构建，可加 `-SkipFrontend` 复用现有 `frontend/dist`。

## 版本一致性

发布标签去掉 `v` 后作为唯一版本输入：

- `scripts/build.ps1 -Version` 通过 `-ldflags` 注入后端 `/api/health.version`；
- Vite 使用 `LOCAL_GALLERY_VERSION` 覆盖 `package.json` 的开发默认版本；
- 未指定版本时，开发构建仍使用前端 `package.json` 与后端源码默认值。

不要为每次提交修改版本号，也不要把 `frontend/dist`、`bin/`、Release 压缩包或运行时缓存提交进仓库。
