// 造一张带 EXIF GPS 与拍摄时间的极小 JPEG。
//
// 足迹页的端到端用例需要真的带坐标的照片：没有坐标就没有行程、没有停留
// 点，右栏的地图也无从谈起。临时媒体库里其余素材都是没有 EXIF 的 PNG，
// 所以这里手写一个 APP1 段塞进一张 1×1 的 JPEG —— 让库里出现可解码、带
// 坐标、带拍摄时间的照片。
//
// 只写足迹用例需要的几个字段：GPS 纬度经度、GPS 参考方向、拍摄时间。

// 一张 1×1 的灰度 JPEG（SOI + APP0 + DQT + SOF0 + DHT + DHT + SOS + EOI）。
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)

/** EXIF 的字段类型。 */
const TYPE_ASCII = 2
const TYPE_LONG = 4
const TYPE_RATIONAL = 5

/**
 * 十进制度转 EXIF 的度分秒。
 *
 * 分子分母分开存（有理数），秒保留两位小数。
 */
function toRationals(degrees) {
  const abs = Math.abs(degrees)
  const whole = Math.floor(abs)
  const minutes = Math.floor((abs - whole) * 60)
  const seconds = Math.round((abs - whole - minutes / 60) * 3600 * 100)
  return [
    [whole, 1],
    [minutes, 1],
    [seconds, 100],
  ]
}

function rationals(values) {
  const buffer = Buffer.alloc(values.length * 8)
  values.forEach(([numerator, denominator], index) => {
    buffer.writeUInt32LE(numerator >>> 0, index * 8)
    buffer.writeUInt32LE(denominator >>> 0, index * 8 + 4)
  })
  return buffer
}

/**
 * 一个 IFD：条目数 + 条目 + 下一级 IFD 的偏移（0 表示没有）。
 *
 * 条目里放不下的值（超过四字节）用偏移指向数据区。
 */
function ifd(entries) {
  const buffer = Buffer.alloc(2 + entries.length * 12 + 4)
  buffer.writeUInt16LE(entries.length, 0)
  entries.forEach((entry, index) => {
    const at = 2 + index * 12
    buffer.writeUInt16LE(entry.tag, at)
    buffer.writeUInt16LE(entry.type, at + 2)
    buffer.writeUInt32LE(entry.count, at + 4)
    if (typeof entry.value === 'number') {
      buffer.writeUInt32LE(entry.value, at + 8)
    } else {
      entry.value.copy(buffer, at + 8)
    }
  })
  buffer.writeUInt32LE(0, 2 + entries.length * 12)
  return buffer
}

/**
 * 一张带 GPS 的 JPEG。
 *
 * @param {{latitude: number, longitude: number, takenAt: string}} options
 *   takenAt 用 EXIF 的写法："2024:05:02 10:00:00"。
 */
export function gpsJpeg({ latitude, longitude, takenAt }) {
  const header = Buffer.alloc(8)
  header.write('II', 0, 'ascii')
  header.writeUInt16LE(0x2a, 2)
  header.writeUInt32LE(8, 4)

  const ifd0Size = 2 + 2 * 12 + 4
  const exifIfdSize = 2 + 1 * 12 + 4
  const gpsIfdSize = 2 + 4 * 12 + 4

  const exifIfdOffset = 8 + ifd0Size
  const gpsIfdOffset = exifIfdOffset + exifIfdSize
  const dataOffset = gpsIfdOffset + gpsIfdSize

  const dateBytes = Buffer.from(takenAt + '\0', 'ascii')
  const dateOffset = dataOffset
  const latitudeOffset = dateOffset + dateBytes.length
  const longitudeOffset = latitudeOffset + 24

  const ifd0 = ifd([
    { tag: 0x8769, type: TYPE_LONG, count: 1, value: exifIfdOffset },
    { tag: 0x8825, type: TYPE_LONG, count: 1, value: gpsIfdOffset },
  ])
  const exifIfd = ifd([
    {
      tag: 0x9003,
      type: TYPE_ASCII,
      count: dateBytes.length,
      value: dateOffset,
    },
  ])
  const gpsIfd = ifd([
    {
      tag: 0x0001,
      type: TYPE_ASCII,
      count: 2,
      value: Buffer.from(latitude >= 0 ? 'N\0' : 'S\0', 'ascii'),
    },
    {
      tag: 0x0002,
      type: TYPE_RATIONAL,
      count: 3,
      value: latitudeOffset,
    },
    {
      tag: 0x0003,
      type: TYPE_ASCII,
      count: 2,
      value: Buffer.from(longitude >= 0 ? 'E\0' : 'W\0', 'ascii'),
    },
    {
      tag: 0x0004,
      type: TYPE_RATIONAL,
      count: 3,
      value: longitudeOffset,
    },
  ])

  const tiff = Buffer.concat([
    header,
    ifd0,
    exifIfd,
    gpsIfd,
    dateBytes,
    rationals(toRationals(latitude)),
    rationals(toRationals(longitude)),
  ])

  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'ascii'),
    tiff,
  ])
  const segment = Buffer.alloc(4)
  segment.writeUInt16BE(0xffe1, 0)
  segment.writeUInt16BE(payload.length + 2, 2)

  return Buffer.concat([
    BASE_JPEG.subarray(0, 2),
    segment,
    payload,
    BASE_JPEG.subarray(2),
  ])
}
