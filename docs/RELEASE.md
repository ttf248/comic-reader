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

VSCode 的 `build: all` 任务在 Windows 上调用 `build.bat --no-pause`，生成相同的启动产物。发布压缩包仍使用包内 `staticDir: "dist"` 布局，与源码目录运行方式区分。

## 发布线

GitHub 上已有的 `v1.0.0`～`v1.9.0` 是旧 Python/PyInstaller 架构的历史版本，保持只读，不再用当前代码重建或覆盖这些 Release。

当前 `main` 是 Go + React 架构，首个正式版本从 `v2.0.0` 开始。版本号遵循 SemVer：

- `v2.x.y`：当前架构的正式版本；
- `v2.x.y-rc.n`：候选版本，GitHub Release 会标记为 prerelease；
- 破坏性架构或配置契约变化提升主版本号。

普通提交不会自动创建 Release。这样可以让每次 push 都有构建反馈，同时把面向用户的版本发布保留为显式标签操作。

## 自动构建链路

```text
本地改动
  → scripts/publish.ps1
  → 构建/测试/提交/推送当前分支
  → CNB .cnb.yml 同步到 GitHub，并发送 cnb_sync dispatch（当前 origin 为 CNB 时）
  → GitHub CI（每个分支 push、CNB dispatch、main PR）
```

GitHub 直接收到分支 push 时也会触发同一个 CI。CNB 同步成功后额外发送 `repository_dispatch`，并携带分支与提交 SHA；CI 会按该 SHA 检出代码，避免镜像 push 没有生成 run 时漏掉构建。CNB 机密仓库中的 `GIT_ACCESS_TOKEN` 除了需要能推送 GitHub 仓库，还需要具备发送 repository dispatch 的权限；缺少该权限时 CNB 阶段会失败并明确暴露配置问题。CI 会运行后端测试、前端 lint、前端测试，并构建一个 Linux 验证包；构建包仅保留 7 天，不作为正式 Release。

运行自动提交、推送和状态轮询：

```powershell
pwsh -File scripts/publish.ps1 -Message "feat: 描述本次改动"
```

脚本默认推送到当前 Git 远端的 `origin` 和当前分支，并轮询 `ttf248/local-gallery` 对应提交的 Actions。公开仓库可不提供 Token；频繁监控或私有仓库建议设置 `GH_TOKEN`，也可以通过 `-Token` 传入。需要只提交推送而不等待状态时使用 `-SkipMonitor`；跳过本地验证仅适合明确的文档或紧急修复场景：

```powershell
pwsh -File scripts/publish.ps1 `
  -Message "docs: 更新说明" `
  -SkipValidation
```

只监控已有提交：

```powershell
$sha = (git rev-parse HEAD).Trim()
pwsh -File scripts/watch-github-actions.ps1 -CommitSha $sha
```

## 正式发布

发布前先确认 `main` 的 CI 已通过，然后创建并推送一个带注释的 `v2.*` 标签。标签需要被推送到 GitHub，若本地 `origin` 是 CNB 镜像，请使用已配置认证的 GitHub 远端推送标签：

```powershell
git tag -a v2.0.0 -m "发布 v2.0.0"
# 如果本地还没有 GitHub 远端，只需配置一次：
git remote add github https://github.com/ttf248/local-gallery.git
git push github v2.0.0
```

也可以在 GitHub Actions 页面手动运行 `Release`，填写一个已经存在的 `v2.x.y` 标签。发布工作流会：

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
