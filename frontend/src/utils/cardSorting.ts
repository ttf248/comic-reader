// 列表排序的共用比较器。
//
// 各页的排序分支都长一个样，但口径必须一致：首页的「最近加入」专区
// 用的是后端给的业务日期（拍摄时间 > 文件夹名日期 > 修改时间），
// 列表里的「按加入时间」如果按修改时间排，两处对不上，读者会以为
// 排序坏了。

import { compareDatesDesc } from "./date";

/** 带日期的条目：卡片与后端摘要都满足。 */
export interface DatedEntry {
  /** 业务日期（ISO）：拍摄时间 > 文件夹名日期 > 修改时间。 */
  date?: string;
  /** 文件修改时间：业务日期缺失时兜底。 */
  modTime?: string;
}

/**
 * 「按加入时间」：业务日期倒序，缺业务日期时退回修改时间。
 *
 * 与后端 `albumMoreRecent` 同一口径。
 */
export function compareByAdded(first: DatedEntry, second: DatedEntry): number {
  return compareDatesDesc(
    first.date ?? first.modTime,
    second.date ?? second.modTime,
  );
}
