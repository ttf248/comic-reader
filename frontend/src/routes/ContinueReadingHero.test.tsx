import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContinueReadingHero } from '../components/home/HomeHeroes'

function makeCard(path: string, name: string, index: number, total: number) {
  return {
    id: 'i:' + path,
    variant: 'album' as const,
    title: name,
    count: total,
    imageCount: total,
    videoCount: 0,
    coverPath: path + '/cover.jpg',
    coverKind: 'image' as const,
    to: `/albums/${encodeURIComponent(path)}`,
    progress: { index, total },
  }
}

function renderHero(cards: ReturnType<typeof makeCard>[]) {
  const onContinue = vi.fn()
  const onRemove = vi.fn()
  const onClearAll = vi.fn()
  return {
    onContinue,
    onRemove,
    onClearAll,
    ...render(
      <ContinueReadingHero
        cards={cards}
        onContinue={onContinue}
        onRemove={onRemove}
        onClearAll={onClearAll}
      />,
    ),
  }
}

describe('ContinueReadingHero', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('显示进度中相册数 + 第一张的进度文本', () => {
    renderHero([
      makeCard('/a', 'A', 5, 20), // 5/20
    ])
    // 标题:1 本还没看完
    const heroSection = screen.getByTestId('continue-hero')
    expect(heroSection.textContent).toMatch(/1\s*本还没看完/)
    // 进度文本 看到 6/20(index+1 / total)
    expect(screen.getByText(/看到\s*6\s*\/\s*20/)).toBeInTheDocument()
  })

  it('点击卡片触发 onContinue + 拿到对应 card', () => {
    const { onContinue } = renderHero([
      makeCard('/a', 'A', 5, 20),
      makeCard('/b', 'B', 12, 30),
    ])
    // 外层是 role=button 的 div，div 内部有 X 真 button。
    // 找 "13 / 30" 那个 progress 文本（标记第 2 张 B 的卡），回溯到 role=button 容器。
    const progressText = screen.getByText(/看到\s*13\s*\/\s*30/)
    const bCard = progressText.closest('[role="button"]') as HTMLElement
    fireEvent.click(bCard)
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onContinue.mock.calls[0][0].title).toBe('B')
    expect(onContinue.mock.calls[0][0].progress?.index).toBe(12)
  })

  it('cards 超过上限时只显示 1 张主封面 + 12 张封面墙', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeCard(`/p${i}`, `P${i}`, i, 30),
    )
    const { container } = renderHero(many)
    const cardButtons = container.querySelectorAll('button[aria-label^="将"][aria-label$="标记为已读"]')
    // 1 张主封面（"标记为已读"文字按钮）+ 12 张封面墙海报（X 按钮）= 13 个。
    // 上限存在的意义是"首页不铺满 32 本在读"，而不是"只给 6 本"。
    expect(cardButtons.length).toBe(13)
  })

  it('空 cards 仍渲染(由 Home 条件决定是否显示)', () => {
    renderHero([])
    const heroSection = screen.getByTestId('continue-hero')
    expect(heroSection.textContent).toMatch(/0\s*本还没看完/)
  })

  it('点 X 触发 onRemove 且不冒泡到外层 onContinue', () => {
    const { onContinue, onRemove } = renderHero([
      makeCard('/a', 'A', 5, 20),
    ])
    const xBtn = screen.getByLabelText('将A标记为已读')
    fireEvent.click(xBtn)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove.mock.calls[0][0].title).toBe('A')
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('焦点在 X 按钮上按 Enter 时不会触发外层跳转', () => {
    const { onContinue } = renderHero([makeCard('/a', 'A', 5, 20)])
    const xBtn = screen.getByLabelText('将A标记为已读')
    // keydown 从按钮冒泡；外层卡片不得把它当成自己的主操作。
    fireEvent.keyDown(xBtn, { key: 'Enter' })
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('卡片的可访问名不包含 X 按钮的文案', () => {
    const { container } = renderHero([makeCard('/a', 'A', 5, 20)])
    const card = container.querySelector('[role="button"]') as HTMLElement
    expect(card).not.toHaveAccessibleName(/标记为已读/)
  })

  it('点 清空 链接触发 onClearAll', () => {
    const { onClearAll } = renderHero([makeCard('/a', 'A', 1, 10)])
    const clearBtn = screen.getByTitle(/把当前所有继续阅读相册标记为已读/)
    fireEvent.click(clearBtn)
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })
})

// 舞台主封面的尺寸由 CSS 变量 --stage-cover-w 决定（随视口高度收缩，
// 否则 1440×900 这类笔记本高度上主操作「继续阅读」会被滚动容器裁掉）。
// 这里锁住"封面与墙签都用同一个变量"，避免有人改回固定像素。
it('主封面与墙签都跟随 --stage-cover-w，主操作留在同一列里', () => {
  renderHero([makeCard('/a', 'A', 5, 20), makeCard('/b', 'B', 1, 30)])
  const poster = screen.getByRole('button', { name: /继续阅读「A」/ })
  const posterBox = poster.parentElement as HTMLElement
  expect(posterBox.className).toContain('md:w-[var(--stage-cover-w)]')

  // 墙签（标题 + 进度 + 主操作）的宽度同样跟随封面
  const wallLabel = posterBox.parentElement?.children[1] as HTMLElement
  expect(wallLabel.className).toContain('xl:w-[var(--stage-cover-w)]')
  // 窄屏（<768）墙签与封面并排，不再另起一行 —— 另起一行时封面右侧
  // 会空出一大片，主操作也被推到整屏下方。
  expect(wallLabel.className).toContain('flex-1')

  // 主操作按钮与封面同列（缩排在封面的容器里，不是被推到右栏尽头）
  const ctas = screen
    .getAllByRole('button')
    .filter((el) => el.textContent?.trim().startsWith('继续阅读'))
  expect(ctas.length).toBeGreaterThan(0)
})
