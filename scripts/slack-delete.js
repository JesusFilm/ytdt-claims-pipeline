/*
 * Script to delete a Slack message by URL, 
 * Usage: node scripts/slack-delete.js <slack-message-url>
 * E.g. node scripts/slack-delete.js "https://jfp-digital.slack.com/archives/C09KPF83TBJ/p1778786774744369"
 * Note: requires SLACK_BOT_TOKEN env var with permissions to delete messages in the channel
 */
const u = process.argv[2];

if (!u) {
  console.error("Please provide a Slack URL as a command-line argument.");
  process.exit(1);
}

const c = u.match(/archives\/([A-Z0-9]+)/)[1];
const t = u.match(/p(\d{16})/)[1].replace(/(\d{10})(\d+)/, '$1.$2');

require('https').request({
    hostname: 'slack.com',
    path: '/api/chat.delete',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    }
  },
  r => r.on('data', d => console.log(JSON.parse(d)))
).end(JSON.stringify({ channel: c, ts: t }));