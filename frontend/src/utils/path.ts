// 从相册路由提取不透明资源 ID。
export function decodeFavPath(to: string): string {
  if (!to.startsWith('/albums/')) return to
  try {
    return decodeURIComponent(to.replace(/^\/albums\//, ''))
  } catch {
    return to.replace(/^\/albums\//, '')
  }
}

// 把相册资源 ID 编码成 /albums/<encoded-id> 形式。
export function albumRoute(albumId: string): string {
  return `/albums/${encodeURIComponent(albumId)}`
}

// 标签页（新名）：/tags/<encoded tag>
export function tagRoute(tag: string): string {
  return `/tags/${encodeURIComponent(tag)}`
}

// 收藏用的资源 ID：智能集合用 smart: 前缀，其余用收藏路径。
// 卡片星标、右键菜单和收藏页必须用同一套 ID，否则收藏会互相看不见。
export function favoriteResourceId(item: {
  variant?: string
  title: string
  to: string
}): string {
  return item.variant === 'smart' ? `smart:${item.title}` : decodeFavPath(item.to)
}
