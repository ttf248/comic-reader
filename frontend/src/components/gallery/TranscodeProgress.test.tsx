import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { subscribeTranscodeEvents } from '../../api/videos'
import TranscodeProgress from './TranscodeProgress'

type StatusHandler = (status: {
  status: string
  progress: number
  etaSec?: number
}) => void

const handlers: { progress?: StatusHandler } = {}

vi.mock('../../api/videos', () => ({
  subscribeTranscodeEvents: vi.fn((_src: string, h: { onProgress?: StatusHandler }) => {
    handlers.progress = h.onProgress
    return () => {}
  }),
  cancelTranscode: vi.fn(async () => {}),
}))

describe('TranscodeProgress', () => {
  beforeEach(() => {
    handlers.progress = undefined
    vi.clearAllMocks()
  })

  it('转码中显示服务端给出的预计剩余时间', () => {
    render(<TranscodeProgress src="f_1" />)
    act(() => {
      handlers.progress?.({ status: 'running', progress: 0.25, etaSec: 600 })
    })
    expect(screen.getByText(/25%/)).toBeInTheDocument()
    expect(screen.getByText(/预计 10 分钟/)).toBeInTheDocument()
  })

  it('服务端没有给出预计时间时不显示预计文案', () => {
    render(<TranscodeProgress src="f_1" />)
    act(() => {
      handlers.progress?.({ status: 'running', progress: 0.25, etaSec: 0 })
    })
    expect(screen.getByText(/25%/)).toBeInTheDocument()
    expect(screen.queryByText(/预计/)).not.toBeInTheDocument()
  })

  it('用户取消转码后显示已取消，而不是转码失败', async () => {
    render(<TranscodeProgress src="f_1" />)
    act(() => {
      handlers.progress?.({ status: 'running', progress: 0.25, etaSec: 600 })
    })
    fireEvent.click(screen.getByRole('button', { name: '取消转码' }))
    await act(async () => {})
    expect(screen.getByText('已取消转码')).toBeInTheDocument()
    expect(screen.queryByText('转码失败')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新转码' })).toBeInTheDocument()
  })

  it('父组件重渲染不会清空面板状态，也不会重复订阅进度流', () => {
    const { rerender } = render(<TranscodeProgress src="f_1" onReady={() => {}} />)
    act(() => {
      handlers.progress?.({ status: 'running', progress: 0.25, etaSec: 600 })
    })
    expect(screen.getByText(/25%/)).toBeInTheDocument()
    const calls = vi.mocked(subscribeTranscodeEvents).mock.calls.length

    // 父组件重渲染会传新的 onReady 引用：面板状态与订阅都不能因此重置。
    rerender(<TranscodeProgress src="f_1" onReady={() => {}} />)
    expect(screen.getByText(/25%/)).toBeInTheDocument()
    expect(vi.mocked(subscribeTranscodeEvents).mock.calls.length).toBe(calls)
  })

  it('排队时显示等待中而不是进度百分比', () => {
    render(<TranscodeProgress src="f_1" />)
    act(() => {
      handlers.progress?.({ status: 'queued', progress: 0, etaSec: 0 })
    })
    expect(screen.getByText(/等待中/)).toBeInTheDocument()
  })
})
