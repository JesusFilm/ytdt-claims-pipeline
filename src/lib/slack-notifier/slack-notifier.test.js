import axios from 'axios'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('axios')
vi.mock('../../env/index.js', () => ({
  env: {
    SLACK_BOT_TOKEN: 'test-token',
    SLACK_CHANNEL: '#test-channel',
  },
}))

vi.mock('../utils/index.js', () => ({
  formatDuration: (ms) => `${Math.floor(ms / 1000)}s`,
}))

describe('slack-notifier', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    axios.post.mockClear()
    // Ensure env mock is active
    vi.doMock('../../env/index.js', () => ({
      env: {
        SLACK_BOT_TOKEN: 'test-token',
        SLACK_CHANNEL: '#test-channel',
      },
    }))
    vi.resetModules()
  })

  it('should skip notification if SLACK_BOT_TOKEN not set', async () => {
    vi.doMock('../../env/index.js', () => ({
      env: {
        SLACK_BOT_TOKEN: undefined,
        SLACK_CHANNEL: '#test-channel',
      },
    }))
    vi.resetModules()

    const { sendPipelineNotification } = await import('../slack-notifier/index.js')
    await sendPipelineNotification('run-id', 'completed')

    expect(axios.post).not.toHaveBeenCalled()
  })

  it('should send notification for completed pipeline', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } })
    const { sendPipelineNotification } = await import('../slack-notifier/index.js')
    await sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date())

    expect(axios.post).toHaveBeenCalled()
    const callArgs = axios.post.mock.calls[0]
    expect(callArgs[0]).toBe('https://slack.com/api/chat.postMessage')
    expect(callArgs[1]).toMatchObject({
      channel: '#test-channel',
      text: 'Pipeline Completed',
    })
    expect(callArgs[2].headers.Authorization).toBe('Bearer test-token')
  })

  it('should send notification for failed pipeline', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } })
    const { sendPipelineNotification } = await import('../slack-notifier/index.js')
    await sendPipelineNotification('run-id', 'failed', 'Test error', 5000, {}, new Date())

    expect(axios.post).toHaveBeenCalled()
    const callArgs = axios.post.mock.calls[0]
    expect(callArgs[1]).toMatchObject({
      text: 'Pipeline Failed',
    })
  })

  it('should include claims processed in notification', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } })
    const { sendPipelineNotification } = await import('../slack-notifier/index.js')

    const results = {
      claimsProcessed: {
        matter_entertainment: { new: 100, total: 200 },
        matter_2: { new: 50, total: 150 },
      },
    }

    await sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date(), results)

    const callArgs = axios.post.mock.calls[0]
    expect(callArgs[1].blocks[0].text.text).toContain('Claims Processed')
  })

  it('should include verdicts in notification', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } })
    const { sendPipelineNotification } = await import('../slack-notifier/index.js')

    const results = {
      mcnVerdicts: { processed: 50 },
      jfmVerdicts: { processed: 30 },
    }

    await sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date(), results)

    const callArgs = axios.post.mock.calls[0]
    expect(callArgs[1].blocks[0].text.text).toContain('Verdicts Applied')
  })

  it('should handle notification errors gracefully', async () => {
    const { sendPipelineNotification } = await import('../slack-notifier/index.js')
    axios.post.mockRejectedValue(new Error('Network error'))

    await expect(
      sendPipelineNotification('run-id', 'completed', null, 5000, {}, new Date())
    ).resolves.not.toThrow()
  })
})
