import axios from 'axios'

vi.mock('axios')
vi.mock('../../env', () => ({
  env: {
    SLACK_BOT_TOKEN: 'test-token',
    SLACK_CHANNEL: '#test-channel',
  },
}))

vi.mock('../utils', () => ({
  formatDuration: (ms: number) => `${Math.floor(ms / 1000)}s`,
}))

describe('slack-notifier', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    ;(axios.post as unknown as ReturnType<typeof vi.fn>).mockClear()
    // Ensure env mock is active
    vi.doMock('../../env', () => ({
      env: {
        SLACK_BOT_TOKEN: 'test-token',
        SLACK_CHANNEL: '#test-channel',
      },
    }))
    vi.resetModules()
  })

  it('should skip notification if SLACK_BOT_TOKEN not set', async () => {
    vi.doMock('../../env', () => ({
      env: {
        SLACK_BOT_TOKEN: undefined,
        SLACK_CHANNEL: '#test-channel',
      },
    }))
    vi.resetModules()

    const { sendPipelineNotification } = await import('../slack-notifier')
    await sendPipelineNotification('run-id', 'completed')

    expect(axios.post).not.toHaveBeenCalled()
  })

  it('should send notification for completed pipeline', async () => {
    ;(axios.post as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true },
    })
    const { sendPipelineNotification } = await import('../slack-notifier')
    await sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date())

    expect(axios.post).toHaveBeenCalled()
    const callArgs = (axios.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe('https://slack.com/api/chat.postMessage')
    expect(callArgs[1]).toMatchObject({
      channel: '#test-channel',
      text: 'Pipeline Completed',
    })
    expect(callArgs[2].headers.Authorization).toBe('Bearer test-token')
  })

  it('should send notification for failed pipeline', async () => {
    ;(axios.post as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true },
    })
    const { sendPipelineNotification } = await import('../slack-notifier')
    await sendPipelineNotification('run-id', 'failed', 'Test error', 5000, {}, new Date())

    expect(axios.post).toHaveBeenCalled()
    const callArgs = (axios.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[1]).toMatchObject({
      text: 'Pipeline Failed',
    })
  })

  it('should include claims processed in notification', async () => {
    ;(axios.post as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true },
    })
    const { sendPipelineNotification } = await import('../slack-notifier')

    const results = {
      claimsProcessed: {
        matter_entertainment: { new: 100, total: 200 },
        matter_2: { new: 50, total: 150 },
      },
    }

    await sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date(), results)

    const callArgs = (axios.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[1].blocks[0].text.text).toContain('Claims Processed')
  })

  it('should include verdicts in notification', async () => {
    ;(axios.post as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { ok: true },
    })
    const { sendPipelineNotification } = await import('../slack-notifier')

    const results = {
      mcnVerdicts: { processed: 50 },
      jfmVerdicts: { processed: 30 },
    }

    await sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date(), results)

    const callArgs = (axios.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[1].blocks[0].text.text).toContain('Verdicts Applied')
  })

  it('should handle notification errors gracefully', async () => {
    const { sendPipelineNotification } = await import('../slack-notifier')
    ;(axios.post as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error')
    )

    await expect(
      sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date())
    ).resolves.not.toThrow()
  })
})
