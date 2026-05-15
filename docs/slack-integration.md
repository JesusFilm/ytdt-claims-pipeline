# Slack Integration Setup

## Overview

Two capabilities:

1. **Pipeline notifications** — bot posts to channel on completion/failure, with a "Rerun" button on failure
2. **Guided verdicts upload** — Ben runs `/run-verdicts` in Slack and is walked through uploading each verdicts CSV, which then merges with pre-staged claims and fires the pipeline

See [docs/pending-runs.md](./pending-runs.md) for the full claims/verdicts split flow.

```
/run-verdicts
      ↓
Bot prompts for verdicts (MCN Verdicts → JFM Verdicts)
      ↓
User uploads CSV (or skips)
      ↓
Confirm → ▶ Run Pipeline
      ↓
Pipeline Complete → Notification with 📁 View in Drive link
```

## Required Permissions

### Bot Token Scopes
- `chat:write` - Post messages to channels
- `chat:write.public` - Post to channels without joining
- `files:read` - Download uploaded CSV files
- `channels:history` - Read messages in public channels
- `groups:history` - Read messages in private channels

### Slash Commands
- `/run-verdicts` - Starts the guided verdicts upload session

## Setup Steps

### 1. Create Slack App

1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name: "Pipeline Notifier" (or your choice)
4. Select your workspace

### 2. Configure Bot Token Scopes

1. Navigate to **OAuth & Permissions**
2. Under **Bot Token Scopes**, add:
   - `chat:write`
   - `chat:write.public`
   - `files:read`
   - `channels:history`
   - `groups:history`

### 3. Enable Interactivity

1. Navigate to **Interactivity & Shortcuts**
2. Turn on **Interactivity**
3. Set **Request URL**: `https://<backend-url>/api/slack/interactions`
4. Click **Save Changes**

### 4. Enable Events API

1. Navigate to **Event Subscriptions**
2. Turn on **Enable Events**
3. Set **Request URL**: `https://<backend-url>/api/slack/events`
4. Under **Subscribe to bot events**, add:
   - `message.channels` (public channels)
   - `message.groups` (private channels)
5. Click **Save Changes**

### 5. Create Slash Command

1. Navigate to **Slash Commands**
2. Click **Create New Command**
3. Set:
   - Command: `/run-verdicts`
   - Request URL: `https://<backend-url>/api/slack/commands`
   - Short Description: `Upload verdicts and run the pipeline`
4. Click **Save**

### 6. Install App to Workspace

1. Navigate to **Install App**
2. Click **Install to Workspace**
3. Authorize the app
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 7. Get Signing Secret

1. Navigate to **Basic Information**
2. Under **App Credentials**, copy the **Signing Secret**

### 8. Configure Environment Variables

Add to your `.env` file:

```bash
SLACK_BOT_TOKEN=xoxb-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
SLACK_CHANNEL=#ytdt-pipeline
```

### 9. Invite Bot to Channel

In Slack, go to your target channel and type:
```
/invite @Pipeline Notifier
```

## Testing

**Test bot can post:**
```shell
curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"channel":"#ytdt-pipeline","text":"test"}'
```

**Test guided verdicts upload:**
1. Have Data Engineering stage claims via the UI first (see [pending-runs.md](./pending-runs.md))
2. Type `/run-verdicts` in the channel
3. Upload MCN and JFM verdicts CSVs when prompted (or skip)
4. Click "▶ Run Pipeline" on the confirmation screen
5. Verify pipeline starts and completion notification arrives with Drive link

**Test pipeline notifications:**

Trigger a failed pipeline run and verify:
1. Message appears in configured channel
2. "Rerun Pipeline" button is visible
3. Clicking button triggers rerun

## Troubleshooting

**"Invalid signature" errors:**
- Verify `SLACK_SIGNING_SECRET` is correct
- Check system clock is synchronized

**Messages not appearing:**
- Verify `SLACK_BOT_TOKEN` is correct
- Check bot has required scopes
- Ensure channel name includes `#` prefix

**File uploads not detected:**
- Verify `message.channels` and `message.groups` events are subscribed under Event Subscriptions
- Verify `files:read` scope is granted
- Check bot is invited to the channel
- Reinstall the app after any scope changes

**Button clicks not working:**
- Verify Interactivity Request URL is set to `/api/slack/interactions` (not `/api/slack/commands`)
- Check backend logs for errors
- Ensure HTTPS is used (Slack requires HTTPS)

**No claims staged error:**
- Data Engineering must upload claims via the UI and click "Save & Wait for Verdicts" before Ben runs `/run-verdicts`
- See [pending-runs.md](./pending-runs.md)

## Deleting Bot Messages

**Option 1 — script:**

```shell
node scripts/slack-delete.js "https://jfp-digital.slack.com/archives/C09KPF83TBJ/p1759959559103239"
```

Requires `SLACK_BOT_TOKEN` env var set.

**Option 2 — curl:**

Extract the message timestamp and channel ID from the message URL:
e.g. `https://jfp-digital.slack.com/archives/C09KPF83TBJ/p1759959559103239`
→ channel: `C09KPF83TBJ`, ts: `1759959559.103239`

```shell
curl -X POST https://slack.com/api/chat.delete \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "C09KPF83TBJ",
    "ts": "1759959559.103239"
  }'
```