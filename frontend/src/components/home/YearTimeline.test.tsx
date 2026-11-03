import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import YearTimeline from './YearTimeline'
import { useSearchStore } from '../../store/searchStore'
import type { YearGroup } from '../../utils/albumGrouping'
import type { CardData } from '../album/AlbumCard'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

// 只替换 useNavigate，其余导出（MemoryRouter 等）保持真实实现。
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

function makeCard(id: string): CardData {
  return {
    id,
    variant: 'album',
    title: id,
    count: 3,
    imageCount: 3,
    videoCount: 0,
    coverPath: `/${id}/cover.jpg`,
    coverKind: 'image',
    to: `/albums/${id}`,
  }
}

function makeGroup(year: number, albumCount = 1): YearGroup {
  return {
    year,
    label: String(year),
    albums: Array.from({ length: albumCount }, (_, i) => makeCard(`a${i}`)),
    totalFiles: 3 * albumCount,
    imageTotal: 3 * albumCount,
    videoTotal: 0,
    coverPreviewPaths: [`/a0/cover.jpg`],
  }
}

function renderTimeline(groups: YearGroup[]) {
  return render(
    <MemoryRouter>
      <YearTimeline groups={groups} />
    </MemoryRouter>,
  )
}

describe('YearTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSearchStore.setState({ yearFilter: null })
  })

  it('代表封面加载失败时降级为年份卡，不露出破图', () => {
    const { container } = renderTimeline([makeGroup(2024)])
    const img = container.querySelector('img')
    expect(img).not.toBeNull()

    // 封面可能是已删除的文件（404）或无法解码的格式（415）。
    fireEvent.error(img as HTMLImageElement)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('2024')).toBeInTheDocument()
  })

  it('漏斗按钮不进入年份卡的可访问名', () => {
    renderTimeline([makeGroup(2024)])
    const card = screen.getByRole('button', { name: /2024/ })
    expect(card).not.toHaveAccessibleName(/筛选该年份/)
    expect(screen.getByRole('button', { name: '筛选该年份' })).toBeInTheDocument()
  })

  it('焦点在漏斗按钮上按 Enter 只切换筛选，不会跳转相册', () => {
    renderTimeline([makeGroup(2024)])
    const filterButton = screen.getByRole('button', { name: '筛选该年份' })

    // keydown 会从按钮冒泡；年份卡不得把它当成自己的主操作。
    fireEvent.keyDown(filterButton, { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('点击漏斗按钮切换该年份筛选，且不触发跳转', () => {
    renderTimeline([makeGroup(2024)])
    fireEvent.click(screen.getByRole('button', { name: '筛选该年份' }))

    expect(useSearchStore.getState().yearFilter).toBe(2024)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('再次点击漏斗按钮取消该年份筛选', () => {
    renderTimeline([makeGroup(2024)])
    const filterButton = screen.getByRole('button', { name: '筛选该年份' })

    fireEvent.click(filterButton)
    expect(useSearchStore.getState().yearFilter).toBe(2024)
    // 激活态下按钮文案变为「取消年份筛选」。
    fireEvent.click(screen.getByRole('button', { name: '取消年份筛选' }))
    expect(useSearchStore.getState().yearFilter).toBeNull()
  })

  it('在年份卡上按 Enter 仍然打开该年份唯一的相册', () => {
    renderTimeline([makeGroup(2024)])
    const card = screen.getByRole('button', { name: /2024/ })

    fireEvent.keyDown(card, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith('/albums/a0')
  })

  it('多相册的年份按 Enter 走筛选而不是跳转', () => {
    renderTimeline([makeGroup(2024, 3)])
    const card = screen.getByRole('button', { name: /2024/ })

    fireEvent.keyDown(card, { key: 'Enter' })
    expect(navigate).not.toHaveBeenCalled()
    expect(useSearchStore.getState().yearFilter).toBe(2024)
  })
})
