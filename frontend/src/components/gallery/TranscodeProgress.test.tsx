import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
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

  it('排队时显示等待中而不是进度百分比', () => {
    render(<TranscodeProgress src="f_1" />)
    act(() => {
      handlers.progress?.({ status: 'queued', progress: 0, etaSec: 0 })
    })
    expect(screen.getByText(/等待中/)).toBeInTheDocument()
  })
})
