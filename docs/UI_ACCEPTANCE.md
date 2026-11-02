# UI / UX 验收清单（第二轮）

> 本文件是 2026-11 第二轮 UI/UX 改造的验收清单。
> 第一轮的设计规范与两轮评审记录见 [docs/UI_REDESIGN.md](./UI_REDESIGN.md)。
>
> 状态定义：
> - `OPEN` —— 尚未处理
> - `IN_PROGRESS` —— 正在实施
> - `BLOCKED` —— 有可证实的环境障碍（必须写明证据）
> - `VERIFIED` —— 已实现且通过实际检查（有代码变更 + 运行验证证据）
>
> 规则：**只有经过代码实现和运行验证的问题才能标记 VERIFIED。**
> 截图证据统一放在 `frontend/.smoke/`（已被根 `.gitignore` 的 `.smoke/` 规则忽略，不入库）。

---

## A. 第一轮遗留问题（docs/UI_REDESIGN.md 第 7 节）

| # | 问题 | 状态 | 证据 |
|---|------|------|------|
| A1 | 阅读器顶栏 1440px 下仍偏密（模式组 + 适配 + ★ + ⛶ + ⚙ + ⋯ 共 6 组控件） | VERIFIED | 提交 `502aa33`：阅读控制整体移到画面底部浮动工具条，顶栏只剩返回 / 名称 / 页码 / ★ / ⛶ / ⋯。截图 `frontend/.smoke/a1/`；e2e `smoke.spec.ts` 两条用例（工具条常驻模式与适配、窄屏右侧不再有悬浮控件） |
| A2 | 年份卡的大号年份数字在白底 / 浅色封面（2020 白底文档）上对比度不足 | VERIFIED | 提交 `c0a6046`：年份卡加 85% 黑色渐变蒙版 + 文字描边。截图 `frontend/.smoke/a3clip/`、`frontend/.smoke/a3mark/`（白点 / 年份区块 8× 放大） |
| A3 | 未读页取消「新」角标后，未读状态缺少表达 | VERIFIED | 提交 `e5d236e`：三态系统（未读=白点 / 在读=进度条 / 已读=✓ chip），全部取自真实数据；删除无数据来源的「重温」角标。单元测试 `AlbumCard.test.tsx` 新增 8 例；截图 `frontend/.smoke/a3z2/`、`frontend/.smoke/a3read/` |
| A4 | 深色主题未做 WCAG AA 对比度审计（顺带发现浅色主题同样不达标） | VERIFIED | 提交 `e38d8f7`：新增 `frontend/scripts/contrast-audit.mjs`（DOM 判定 + 像素判定 + `--self-test` 自检），审计前 132 处不达标 → 修复后 0 处。命令 `npm run audit:contrast` |
| A5 | 平板断点（768 / 1024px）未走查 | VERIFIED | 提交 `c0cad04`：溢出用例扩到 1920 / 1440 / 1024 / 768 / 390 五档并逐档实跑；截图 `frontend/.smoke/a5/`（首页 / 未读 / 最近 / 设置 / 文件夹页，明暗两套）与 `frontend/.smoke/a5d/`（768px 下的右键菜单与属性弹窗） |
| A6 | 主要网格加载仍是转圈 + 文案，没有布局稳定的骨架屏 | VERIFIED | 提交 `db88d58`：新增 `AlbumGridSkeleton`，首页 / 未读 / 最近 / 收藏 / 文件夹页改用与真实网格同形的骨架；截图 `frontend/.smoke/a6c/`（API 延迟 4 秒后的加载态） |
| A7 | 列表视图在超宽屏仍是单列，标题与右侧数字之间大片空白 | VERIFIED | 提交 `59e05e2`：≥1536px 列表改双列、行高固定 86px；截图 `frontend/.smoke/a7b/`（1920px 下 10 项排成 5 行 2 列） |

---

## B. 本轮必须完成的验证项

| # | 验收项 | 状态 | 证据 |
|---|--------|------|------|
| B1 | 1920px（超宽屏）主要页面无溢出、布局合理 | VERIFIED | 截图 `frontend/.smoke/final/light-wide-*.png`（首页 / 未读 / 最近 / 收藏 / 设置 / 文件夹页 / 阅读器）；e2e「1920px 下首页、相册与阅读器均无横向溢出」；列表在 1920 改双列（提交 `59e05e2`） |
| B2 | 768px（平板竖屏）导航 / 筛选 / 卡片 / 阅读器 / 弹窗可用 | VERIFIED | 截图 `frontend/.smoke/final/{light,dark}-ipad-*.png` 与 `frontend/.smoke/a5d/768-menu.png`、`768-props.png`（右键菜单、属性弹窗）；e2e「768px 下……均无横向溢出」 |
| B3 | 1024px（平板横屏）同上 | VERIFIED | 截图 `frontend/.smoke/final/{light,dark}-tablet-*.png`；e2e「1024px 下……均无横向溢出」 |
| B4 | 1440px 桌面 + 390px 手机，浅色 / 深色均已实际运行检查 | VERIFIED | 截图 `frontend/.smoke/final/`（1920 / 1440 / 1024 / 768 / 390 五档 × 明暗两套 × 7 个页面，共 70 张） |
| B5 | 阅读器：翻页 / 单页 / 双页 / 连续 / 缩放 / 适配 / 旋转 / 全屏 / 快捷键无回归 | VERIFIED | e2e 覆盖：底部工具条切模式与适配、连续模式按视口请求预览图、原始适配按像素、放大与旋转作用到图片、方向键 / PageUp / PageDown / g / Home / End / Space 快捷键、图片信息面板不遮顶栏；本轮补「阅读器全屏按钮可点击」1 条 |
| B6 | 收藏 / 未读 / 继续阅读 / 搜索筛选 / 设置保存功能正常 | VERIFIED | e2e 覆盖收藏标记 / 失效收藏清理、未读页标记与取消已读、继续阅读区块、搜索与筛选、设置保存；单元测试覆盖各页加载与空态 |
| B7 | `npm run build` / `npm run lint` / `npm run test` 全通过 | VERIFIED | build：`tsc -b && vite build` 通过；lint：0 error（2 条既有 warning）；test：75 文件 / 582 用例全绿 |
| B8 | Playwright E2E 全通过，且新增覆盖本轮修复的用例 | VERIFIED | `pwsh -NoProfile -File scripts/test-e2e.ps1`：121 条用例全通过（真实起 Go 后端 + 临时媒体目录 + 独立前端产物）；本轮新增 6 条（五档溢出、双列列表、全屏按钮）并改写 2 条阅读器用例 |

---

## C. 状态

> 每完成一项即在此更新，并写明验证方式与产物位置。

### C1. 已完成

| 项 | 提交 | 验证方式 |
|----|------|----------|
| A1 阅读器控制层级 | `502aa33` | 1440 / 390 截图 + e2e 两条用例 |
| A2 年份卡对比度 | `c0a6046` | 年份区块 8× 放大截图 |
| A3 卡片状态表达 | `e5d236e` | Vitest 8 例 + 运行态截图 |
| A4 对比度审计 | `e38d8f7` | `npm run audit:contrast`（含 `--self-test`）全绿 |

### C2. 第二遍全产品复审（section 三）中发现并已修复的问题

| 问题 | 提交 | 说明 |
|------|------|------|
| 浅色主题次级文字只有 2.5:1，10px 中文遍布界面 | `1dd628c` | 字号统一提到规范下限 12.5px，中文标签去掉 uppercase / 大字距 |
| 收藏页"1 项"配一张空网格 | `1dd628c` | 改成"N 项可用 · M 项暂不可用"，空状态说明失效原因 |
| 首页正文中重复一排与侧边栏相同的快捷入口 | `1b9320b` | 删除正文中间的按钮排，浏览主线不再被切断 |
| 三个图标按钮只有 title，读屏软件读不到名称 | `1b9320b` | 补 aria-label |

### C3. 复审方式

- 逐页截图（`frontend/.smoke/pages.mjs`）：首页 / 未读 / 最近 / 收藏 /
  设置 / 文件夹页 / 阅读器，明暗两套主题。
- 自动检查脚本（临时，不入仓）：
  - `.smoke/overflow.mjs`：五档断点逐元素查横向溢出；
  - `.smoke/typesize.mjs`：扫描渲染后的实际字号；
  - `.smoke/nameless.mjs`：找没有可访问名的按钮；
  - `.smoke/tab.mjs`：连按 Tab 检查焦点环；
  - `scripts/contrast-audit.mjs`（已入库）：对比度审计。
