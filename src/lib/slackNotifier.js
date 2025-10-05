const axios = require('axios');

async function sendPipelineNotification(runId, status, error = null, duration = null, files = {}, startTime = null) {
  if (!process.env.SLACK_BOT_TOKEN) {
    return;
  }

  const channel = process.env.SLACK_CHANNEL || '#ytdt-pipeline';
  const isFailure = status === 'failed' || status === 'timeout';
  const emoji = isFailure ? '❌' : '✅';
  const statusText = status === 'timeout' ? 'Timed Out' :
                     status === 'failed' ? 'Failed' : 'Completed';

  const filesList = Object.keys(files).filter(k => files[k]).join(', ') || 'None';
  const durationText = duration ? `${Math.round(duration / 1000)}s` : 'N/A';
  const startTimeText = startTime ? `\nStarted: ${new Date(startTime).toLocaleString()}` : '';
  let text = `${emoji} Pipeline Run ${statusText}\nRun ID: ${runId}\nDuration: ${durationText}${startTimeText}\nFiles: ${filesList}`;

  if (error) {
    text += `\nError: ${error}`;
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text
      }
    }
  ];

  if (isFailure) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Rerun Pipeline'
          },
          action_id: 'rerun_pipeline',
          value: runId,
          style: 'primary'
        }
      ]
    });
  }

  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel,
        text: `Pipeline ${statusText}`,
        blocks
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Slack notification sent for run ${runId}`);
  } catch (err) {
    console.error('Failed to send Slack notification:', err.message);
  }
}

module.exports = { sendPipelineNotification };