const axios = require('axios');
const { formatDuration } = require('./utils');

async function sendPipelineNotification(runId, status, error = null, duration = null, files = {}, startTime = null, results = null) {
  if (!process.env.SLACK_BOT_TOKEN) {
    return;
  }

  const channel = process.env.SLACK_CHANNEL || '#ytdt-pipeline';
  const isFailure = status === 'failed' || status === 'timeout';
  const emoji = isFailure ? '❌' : '✅';
  const statusText = status === 'timeout' ? 'Timed Out' :
    status === 'failed' ? 'Failed' : 'Completed';

  const filesList = Object.keys(files).filter(k => files[k]).join(', ') || 'None';
  const durationText = formatDuration(duration);
  const startTimeText = startTime ? `\nStarted: ${new Date(startTime).toLocaleString()}` : '';
  const source = files.claimsSource || 'unknown';
  const driveFolderUrl = results?.driveFolderUrl;
  const invalidMCIDs = (results?.mcnVerdicts?.invalidMCIDs?.length || 0) + (results?.jfmVerdicts?.invalidMCIDs?.length || 0);
  const invalidLanguageIDs = (results?.mcnVerdicts?.invalidLanguageIDs?.length || 0) + (results?.jfmVerdicts?.invalidLanguageIDs?.length || 0);
  const issuesText = (invalidMCIDs || invalidLanguageIDs) ? `\n⚠️ Issues: ${invalidMCIDs} invalid MCIDs, ${invalidLanguageIDs} invalid Language IDs` : '';
  
  let text = `${emoji} Pipeline Run ${statusText}\nRun ID: ${runId}\nSource: ${source}\nDuration: ${durationText}${startTimeText}\nFiles: ${filesList}${issuesText}`;
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

  // Add Drive link button for successful runs
  if (status === 'completed' && driveFolderUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📁 View in Drive'
          },
          url: driveFolderUrl,
          style: 'primary'
        }
      ]
    });
  }

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