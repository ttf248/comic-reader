# Frontend · React + Vite + TypeScript

> 本地画廊（Local Gallery）前端 SPA。

主文档见仓库根 [README.md](../README.md) / [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。本文件只写前端本地开发相关的速查。

## 启动

```bash
npm install
npm run dev
```

默认开发服务器：<http://localhost:5173>

通过 Vite proxy 转发 `/api` 到后端 `http://127.0.0.1:8080`；代理会同步改写 Host 与 Origin，以满足后端的同源访问门禁。

## 构建

```bash
npm run build      # 输出到 dist/
npm run preview    # 本地预览生产构建
```

## 测试

```bash
npm run test             # 单元测试
npx playwright test      # e2e 测试
npm run audit:contrast   # 对比度审计（需要 dev server 或后端在跑）
```

### 对比度审计

`scripts/contrast-audit.mjs` 按 WCAG 2.1 AA 检查运行中的界面：

- **DOM 判定**：沿祖先链合成背景色，算文字与背景的对比度；
- **像素判定**：压在图片 / 渐变上的文字静态算不出背景，改为截屏后取
  文字包围盒外一圈像素当底色，按最不利的一侧算；
- **自检**：`--self-test` 会注入已知好坏样本，先证明工具分得清，
  再看它报"全部通过"。

```bash
npm run audit:contrast                      # 默认页面，明暗两套主题
npm run audit:contrast -- --self-test       # 自检
LG_PAGES=/,/unread npm run audit:contrast  # 自定义页面
```

有低于 AA 阈值的项时进程退出码为 1。

## 环境变量

复制 `.env.example` 为 `.env` 修改。

| 变量            | 用途                                        |
| --------------- | ------------------------------------------- |
| `VITE_API_BASE` | API 基础路径（默认空，同源或经 Vite proxy） |
