const axios = require('axios');
const { formatDuration, formatTimestamp } = require('./utils');

// Trailing options object rather than a tenth positional argument.
//   options.steps - the run's step filter, when it ran only a subset
async function sendPipelineNotification(runId, status, error = null, duration = null, files = {}, startTime = null, results = null, triggeredBy = null, stepName = null, options = {}) {
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
  const startTimeText = formatTimestamp(startTime);
  const driveFolderUrl = results?.driveFolderUrl;
  const frontendUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/?run=${runId}` : null;

  // Build files list
  const uploadedFiles = [];
  if (files.claims?.matter_entertainment) uploadedFiles.push('Claims (ME)');
  if (files.claims?.matter_2) uploadedFiles.push('Claims (M2)');
  if (files.mcnVerdicts) uploadedFiles.push('MCN Verdicts');
  if (files.jfmVerdicts) uploadedFiles.push('JFM Verdicts');
  const filesText = uploadedFiles.length > 0 ? uploadedFiles.join(', ') : 'None';
  const triggerText = triggeredBy ? `\nTriggered: ${triggeredBy.source} by ${triggeredBy.user}` : '';

  // Only shown when the run was filtered to a subset of steps. Without it a
  // scoring-only run and a full run with no uploads both read "Files: None"
  // and are indistinguishable.
  const stepsText = Array.isArray(options.steps) && options.steps.length
    ? `\nSteps: ${options.steps.join(', ')}`
    : '';

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
      claimsText = `\n\n*Claims Processed (${totalNew.toLocaleString()} new)*\n${sources.join('\n')}`;
    }
  }

  // Build verdicts section
  let verdictsText = '';
  const mcnProcessed = results?.mcnVerdicts?.processed || 0;
  const jfmProcessed = results?.jfmVerdicts?.processed || 0;
  if (mcnProcessed || jfmProcessed) {
    const totalProcessed = mcnProcessed + jfmProcessed;
    verdictsText = `\n\n*Verdicts Applied (${totalProcessed.toLocaleString()} total)*`;
    if (mcnProcessed) verdictsText += `\n  • MCN: ${mcnProcessed.toLocaleString()} processed`;
    if (jfmProcessed) verdictsText += `\n  • JFM: ${jfmProcessed.toLocaleString()} processed`;
  }

  // Build shorts section
  let shortsText = '';
  if (results?.enrichShorts) {
    const { checked, marked } = results.enrichShorts;
    shortsText = `\n\n*Shorts Detected (${marked.toLocaleString()} / ${checked.toLocaleString()} checked)*`;
  }

  // Build issues section
  let issuesText = '';
  const invalidMCIDs = (results?.mcnVerdicts?.invalidMCIDs?.length || 0) + (results?.jfmVerdicts?.invalidMCIDs?.length || 0);
  const invalidLanguageIDs = (results?.mcnVerdicts?.invalidLanguageIDs?.length || 0) + (results?.jfmVerdicts?.invalidLanguageIDs?.length || 0);
  if (invalidMCIDs || invalidLanguageIDs) {
    const issues = [];
    if (invalidMCIDs) issues.push(`  • Invalid MCIDs: ${invalidMCIDs}`);
    if (invalidLanguageIDs) issues.push(`  • Invalid Language IDs: ${invalidLanguageIDs}`);
    issuesText = `\n\n*Data Quality Issues*\n${issues.join('\n')}`;
  }

  const header = stepName
    ? `🔁 *Step Restarted: ${stepName}*`
    : `${emoji} *Pipeline Run ${statusText}*`;
  let text = `${header}\n━━━━━━━━━━━━━━━━━━━━━━\nDuration: ${durationText}\nStarted: ${startTimeText}${triggerText}\nFiles: ${filesText}${stepsText}\nRun: \`${runId}\`${claimsText}${verdictsText}${shortsText}${issuesText}`;
  
  if (error) {
    text += `\n\n*Error*\n${error}`;
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

  // Add Console link button for all runs
  if (frontendUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔍 View in Console' },
          url: frontendUrl,
        },
        ...(status === 'completed' && driveFolderUrl ? [{
          type: 'button',
          text: { type: 'plain_text', text: '📁 View in Drive' },
          url: driveFolderUrl,
          style: 'primary'
        }] : [])
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
        text: stepName ? `Step restarted: ${stepName}` : `Pipeline ${statusText}`,
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
    console.error('Failed to send Slack notification:', err.message, err.code, err.response?.data);
  }
}


async function notifyClaimsStaged(claims, stagedBy) {
  if (!process.env.SLACK_BOT_TOKEN) return;
  const channel = process.env.SLACK_CHANNEL || '#ytdt-pipeline';

  const sources = [];
  if (claims.matter_entertainment) sources.push('Matter Entertainment');
  if (claims.matter_2) sources.push('Matter 2');

  const text = `📋 *Claims staged by ${stagedBy}*\nSources: ${sources.join(', ')}\nReady for \`/run-verdicts\``;

  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel, text },
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Failed to notify claims staged:', err.message);
  }
}

// The daily claims ingest can't recover from a rejected sign-in on its own
async function notifyClaimsIngestAuthRequired(error) {
  if (!process.env.SLACK_BOT_TOKEN) return;
  const channel = process.env.SLACK_CHANNEL || '#ytdt-pipeline';

  const text = `🔑 *Daily claims ingest needs re-authorization*\n${error}\n` +
    'Claims stop loading from the YouTube Reporting API until someone signs in again ' +
    '(see docs/claims-reporting-api.md).';

  await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, text },
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

module.exports = { sendPipelineNotification, notifyClaimsStaged, notifyClaimsIngestAuthRequired };
