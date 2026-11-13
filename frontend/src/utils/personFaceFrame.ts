import type { CSSProperties } from "react";

/**
 * Face boxes are stored in source-image pixels. Convert one into the visible
 * tile coordinates used by an object-fit: cover image.
 */
export function personFaceFrameStyle(
  box: number[],
  imageWidth: number,
  imageHeight: number,
  tileWidth: number,
  tileHeight: number,
): CSSProperties | null {
  if (
    box.length !== 4 ||
    ![imageWidth, imageHeight, tileWidth, tileHeight, ...box].every(
      Number.isFinite,
    ) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    tileWidth <= 0 ||
    tileHeight <= 0
  ) {
    return null;
  }

  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0) return null;

  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(imageWidth, x + width);
  const bottom = Math.min(imageHeight, y + height);
  if (right <= left || bottom <= top) return null;

  const scale = Math.max(tileWidth / imageWidth, tileHeight / imageHeight);
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const cropLeft = (renderedWidth - tileWidth) / 2;
  const cropTop = (renderedHeight - tileHeight) / 2;

  return {
    left: `${((left * scale - cropLeft) / tileWidth) * 100}%`,
    top: `${((top * scale - cropTop) / tileHeight) * 100}%`,
    width: `${(((right - left) * scale) / tileWidth) * 100}%`,
    height: `${(((bottom - top) * scale) / tileHeight) * 100}%`,
  };
}
