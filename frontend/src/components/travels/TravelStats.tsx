import type { ReactNode } from "react";

interface TravelStatsProps {
  /** 全库图片总数（不含视频）；null 表示还没取到。 */
  totalPhotos: number | null;
  /** 带位置的照片数。 */
  gpsPhotos: number;
  /** 去过的省、市数。 */
  provinces: number;
  cities: number;
  /** 没有可信拍摄时间的照片数。 */
  untimed: number;
  /** 排在规模信息左边的控件（时间跨度筛选）。 */
  children?: ReactNode;
}

/**
 * 顶部的规模条。
 *
 * 一个主数字加一句补充，而不是一排同样大小的数字：全库有多少张照片是这
 * 一页的分母，带位置的、走过的地方、有多少张没时间，都是从这个分母
 * 里分出来的说法。主次分开，读者一眼知道先看哪个。
 *
 * 左端可以挂一个控件：跨度筛选管的是范围，规模管的是体量，两件事并成
 * 一行，不另起一条抬头。
 */
export default function TravelStats({
  totalPhotos,
  gpsPhotos,
  provinces,
  cities,
  untimed,
  children,
}: TravelStatsProps) {
  return (
    <div className="travel-stats">
      {children ? <div className="travel-stats__scope">{children}</div> : null}
      <p className="travel-stats__hero">
        <span className="travel-stats__hero-value">
          {totalPhotos === null ? "—" : totalPhotos.toLocaleString()}
        </span>
        <span className="travel-stats__hero-label">张照片 · 全库</span>
      </p>
      <div className="travel-stats__rest">
        <span>
          <b className="travel-stats__value">{gpsPhotos.toLocaleString()}</b> 张带位置
        </span>
        <span>
          <b className="travel-stats__value">{provinces}</b> 个省
          <b className="travel-stats__value ml-2">{cities}</b> 个市
        </span>
        <span>
          <b className="travel-stats__value">{untimed.toLocaleString()}</b> 张没有拍摄时间
        </span>
      </div>
    </div>
  );
}
