// 日期相关的轻量工具，避免引入 dayjs / date-fns。

// 时间倒序；缺失或无效时间排在有效时间之后，供调用方继续按名称兜底。
export function compareDatesDesc(first?: string, second?: string): number {
  const firstTime = Date.parse(first ?? "");
  const secondTime = Date.parse(second ?? "");
  if (!Number.isFinite(firstTime)) return Number.isFinite(secondTime) ? 1 : 0;
  if (!Number.isFinite(secondTime)) return -1;
  return secondTime - firstTime;
}

// 距离今天的相对时间（细颗粒度：分钟/小时/天），
// 用于 Recents 列表 / Album 详情页 hero 等"最近多久前"展示。
//   - < 1 分钟  → "刚刚"
//   - < 1 小时  → "N 分钟前"
//   - < 1 天    → "N 小时前"
//   - < 1 周    → "N 天前"
//   - 其余      → 本地化 "月 日"
//
// 解析失败 / 未提供返回 '—'。
export function formatRelative(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// 距离今天多少天的友好描述（粗颗粒度：天/月/年）。
//   - < 1 天 → "刚刚"
//   - 1 天 → "昨天"
//   - < 30 天 → "N 天前"
//   - < 365 天 → "N 个月前"
//   - 其他 → "N 年前"
//
// isoStr 为可解析的时间字符串；解析失败返回 '—'。
export function timeAgo(isoStr: string | undefined | null): string {
  if (!isoStr) return "—";
  const t = new Date(isoStr);
  if (Number.isNaN(+t)) return "—";
  const ms = Date.now() - +t;
  if (ms < 0) return "刚刚";
  const day = 24 * 60 * 60 * 1000;
  const days = Math.floor(ms / day);
  if (days < 1) return "刚刚";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  const years = Math.floor(days / 365);
  return `${years} 年前`;
}
