const axios = require('axios');
const { formatDuration } = require('./utils');

async function sendPipelineNotification(runId, status, error = null, duration = null, files = {}, startTime = null, results = null) {
  if (!process.env.SLACK_BOT_TOKEN) {
    console.log('Slack notifications disabled (no SLACK_BOT_TOKEN)');
    return;
  }

  const channel = process.env.SLACK_CHANNEL || '#ytdt-pipeline';
  const isFailure = status === 'failed' || status === 'timeout';
  const emoji = isFailure ? '❌' : '✅';
  const statusText = status === 'timeout' ? 'Timed Out' :
    status === 'failed' ? 'Failed' : 'Completed';

  const durationText = formatDuration(duration);
  const startTimeText = startTime ? new Date(startTime).toLocaleString() : 'Unknown';
  const driveFolderUrl = results?.driveFolderUrl;
  
  // Build files list
  const uploadedFiles = [];
  if (files.claims?.matter_entertainment) uploadedFiles.push('Claims (ME)');
  if (files.claims?.matter_2) uploadedFiles.push('Claims (M2)');
  if (files.mcnVerdicts) uploadedFiles.push('MCN Verdicts');
  if (files.jfmVerdicts) uploadedFiles.push('JFM Verdicts');
  const filesText = uploadedFiles.length > 0 ? uploadedFiles.join(', ') : 'None';
  
  // Build claims section
  let claimsText = '';
  if (results?.claimsProcessed) {
    const claimsData = results.claimsProcessed;
    const sources = [];
    let totalNew = 0;
    
    if (claimsData.matter_entertainment) {
      sources.push(`  • Matter Entertainment: ${claimsData.matter_entertainment.new.toLocaleString()} new / ${claimsData.matter_entertainment.total.toLocaleString()} total`);
      totalNew += claimsData.matter_entertainment.new;
    }
    if (claimsData.matter_2) {
      sources.push(`  • Matter 2: ${claimsData.matter_2.new.toLocaleString()} new / ${claimsData.matter_2.total.toLocaleString()} total`);
      totalNew += claimsData.matter_2.new;
    }
    
    if (sources.length > 0) {
      claimsText = `\n\n📊 *Claims Processed (${totalNew.toLocaleString()} new)*\n${sources.join('\n')}`;
    }
  }
  
  // Build verdicts section
  let verdictsText = '';
  const mcnProcessed = results?.mcnVerdicts?.processed || 0;
  const jfmProcessed = results?.jfmVerdicts?.processed || 0;
  if (mcnProcessed || jfmProcessed) {
    const totalProcessed = mcnProcessed + jfmProcessed;
    verdictsText = `\n\n📋 *Verdicts Applied (${totalProcessed.toLocaleString()} total)*`;
    if (mcnProcessed) verdictsText += `\n  • MCN: ${mcnProcessed.toLocaleString()} processed`;
    if (jfmProcessed) verdictsText += `\n  • JFM: ${jfmProcessed.toLocaleString()} processed`;
  }
  
  // Build issues section
  let issuesText = '';
  const invalidMCIDs = (results?.mcnVerdicts?.invalidMCIDs?.length || 0) + (results?.jfmVerdicts?.invalidMCIDs?.length || 0);
  const invalidLanguageIDs = (results?.mcnVerdicts?.invalidLanguageIDs?.length || 0) + (results?.jfmVerdicts?.invalidLanguageIDs?.length || 0);
  if (invalidMCIDs || invalidLanguageIDs) {
    const issues = [];
    if (invalidMCIDs) issues.push(`  • Invalid MCIDs: ${invalidMCIDs}`);
    if (invalidLanguageIDs) issues.push(`  • Invalid Language IDs: ${invalidLanguageIDs}`);
    issuesText = `\n\n⚠️ *Data Quality Issues*\n${issues.join('\n')}`;
  }
  
  let text = `${emoji} *Pipeline Run ${statusText}*\n━━━━━━━━━━━━━━━━━━━━━━\n⏱ Duration: ${durationText}\n📅 Started: ${startTimeText}\n📁 Files: ${filesText}\n🆔 Run: \`${runId}\`${claimsText}${verdictsText}${issuesText}`;
  if (error) {
    text += `\n\n❌ *Error*\n${error}`;
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