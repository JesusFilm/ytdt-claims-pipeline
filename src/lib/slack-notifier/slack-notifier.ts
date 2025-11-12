import axios from 'axios'

import { env } from '../../env'
import { formatDuration } from '../utils'

export async function sendPipelineNotification(
  runId: string,
  status: string,
  error: string | null = null,
  duration: number | null = null,
  files: Record<string, unknown> = {},
  startTime: Date | string | null = null,
  results: Record<string, unknown> | null = null
) {
  if (!env.SLACK_BOT_TOKEN) {
    console.log('Slack notifications disabled (no SLACK_BOT_TOKEN)')
    return
  }

  const channel = env.SLACK_CHANNEL
  const isFailure = status === 'failed' || status === 'timeout'
  const emoji = isFailure ? '❌' : '✅'
  const statusText =
    status === 'timeout' ? 'Timed Out' : status === 'failed' ? 'Failed' : 'Completed'

  const durationText = formatDuration(duration)
  const startTimeText = startTime ? new Date(startTime).toLocaleString() : 'Unknown'
  const driveFolderUrl = results?.driveFolderUrl as string | undefined

  // Build files list
  const uploadedFiles: string[] = []
  const filesObj = files.claims as { matter_entertainment?: string; matter_2?: string } | undefined
  if (filesObj?.matter_entertainment) uploadedFiles.push('Claims (ME)')
  if (filesObj?.matter_2) uploadedFiles.push('Claims (M2)')
  if (files.mcnVerdicts) uploadedFiles.push('MCN Verdicts')
  if (files.jfmVerdicts) uploadedFiles.push('JFM Verdicts')
  const filesText = uploadedFiles.length > 0 ? uploadedFiles.join(', ') : 'None'

  // Build claims section
  let claimsText = ''
  const claimsProcessed = results?.claimsProcessed as
    | {
        matter_entertainment?: { new: number; total: number }
        matter_2?: { new: number; total: number }
      }
    | undefined
  if (claimsProcessed) {
    const sources: string[] = []
    let totalNew = 0

    if (claimsProcessed.matter_entertainment) {
      sources.push(
        `  • Matter Entertainment: ${claimsProcessed.matter_entertainment.new.toLocaleString()} new / ${claimsProcessed.matter_entertainment.total.toLocaleString()} total`
      )
      totalNew += claimsProcessed.matter_entertainment.new
    }
    if (claimsProcessed.matter_2) {
      sources.push(
        `  • Matter 2: ${claimsProcessed.matter_2.new.toLocaleString()} new / ${claimsProcessed.matter_2.total.toLocaleString()} total`
      )
      totalNew += claimsProcessed.matter_2.new
    }

    if (sources.length > 0) {
      claimsText = `\n\n📊 *Claims Processed (${totalNew.toLocaleString()} new)*\n${sources.join('\n')}`
    }
  }

  // Build verdicts section
  let verdictsText = ''
  const mcnProcessed = (results?.mcnVerdicts as { processed?: number } | undefined)?.processed || 0
  const jfmProcessed = (results?.jfmVerdicts as { processed?: number } | undefined)?.processed || 0
  if (mcnProcessed || jfmProcessed) {
    const totalProcessed = mcnProcessed + jfmProcessed
    verdictsText = `\n\n📋 *Verdicts Applied (${totalProcessed.toLocaleString()} total)*`
    if (mcnProcessed) verdictsText += `\n  • MCN: ${mcnProcessed.toLocaleString()} processed`
    if (jfmProcessed) verdictsText += `\n  • JFM: ${jfmProcessed.toLocaleString()} processed`
  }

  // Build issues section
  let issuesText = ''
  const invalidMCIDs =
    ((results?.mcnVerdicts as { invalidMCIDs?: unknown[] } | undefined)?.invalidMCIDs?.length ||
      0) +
    ((results?.jfmVerdicts as { invalidMCIDs?: unknown[] } | undefined)?.invalidMCIDs?.length || 0)
  const invalidLanguageIDs =
    ((results?.mcnVerdicts as { invalidLanguageIDs?: unknown[] } | undefined)?.invalidLanguageIDs
      ?.length || 0) +
    ((results?.jfmVerdicts as { invalidLanguageIDs?: unknown[] } | undefined)?.invalidLanguageIDs
      ?.length || 0)
  if (invalidMCIDs || invalidLanguageIDs) {
    const issues: string[] = []
    if (invalidMCIDs) issues.push(`  • Invalid MCIDs: ${invalidMCIDs}`)
    if (invalidLanguageIDs) issues.push(`  • Invalid Language IDs: ${invalidLanguageIDs}`)
    issuesText = `\n\n⚠️ *Data Quality Issues*\n${issues.join('\n')}`
  }

  let text = `${emoji} *Pipeline Run ${statusText}*\n━━━━━━━━━━━━━━━━━━━━━━\n⏱ Duration: ${durationText}\n📅 Started: ${startTimeText}\n📁 Files: ${filesText}\n🆔 Run: \`${runId}\`${claimsText}${verdictsText}${issuesText}`
  if (error) {
    text += `\n\n❌ *Error*\n${error}`
  }

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
  ]

  // Add Drive link button for successful runs
  if (status === 'completed' && driveFolderUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📁 View in Drive',
          },
          url: driveFolderUrl,
          style: 'primary',
        },
      ],
    })
  }

  if (isFailure) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Rerun Pipeline',
          },
          action_id: 'rerun_pipeline',
          value: runId,
          style: 'primary',
        },
      ],
    })
  }

  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel,
        text: `Pipeline ${statusText}`,
        blocks,
      },
      {
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    )
    console.log(`Slack notification sent for run ${runId}`)
  } catch (err) {
    console.error('Failed to send Slack notification:', (err as Error).message)
  }
}
