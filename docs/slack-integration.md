# Slack Integration Setup

## Overview

Two capabilities:

1. **Pipeline notifications** — bot posts to channel on completion/failure, with a "Rerun" button on failure
2. **Guided file upload** — Ben runs `/run-pipeline` in Slack and is walked through uploading each CSV file step by step, then triggers the pipeline without touching the UI

```
/run-pipeline
      ↓
Bot prompts for each file (Claims ME → Claims M2 → MCN Verdicts → JFM Verdicts)
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

### Slash Commands
- `/run-pipeline` - Starts the guided upload session

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
   - `message.channels` (to receive file uploads in channels)
5. Click **Save Changes**

### 5. Create Slash Command

1. Navigate to **Slash Commands**
2. Click **Create New Command**
3. Set:
   - Command: `/run-pipeline`
   - Request URL: `https://<backend-url>/api/slack/commands`
   - Short Description: `Upload claims & verdicts and run the pipeline`
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
SLACK_SIGNING_SECRET=bot-signing-secret-here
SLACK_CHANNEL=#youtube-data-chat
```

### 9. Invite Bot to Channel

In Slack:
1. Go to your target channel (`#youtube-data-chat`)
2. Type `/invite @Pipeline Notifier`

## Testing

**Test bot can post:**
```shell
curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"channel":"#ytdt-pipeline","text":"test"}'
```

**Test guided upload flow:**
1. Type `/run-pipeline` in the channel
2. Follow the prompts — upload a CSV or click "Skip" for each step
3. Click "▶ Run Pipeline" on the confirmation screen
4. Verify pipeline starts and completion notification arrives with Drive link

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
- Verify `message.channels` event is subscribed under Event Subscriptions
- Verify `files:read` scope is granted
- Check bot is invited to the channel

**Button clicks not working:**
- Verify Request URL is publicly accessible
- Check backend logs for errors
- Ensure HTTPS is used (Slack requires HTTPS)

**Delete bot's own messages:**

Extract from bot message url e.g. `https://jfp-digital.slack.com/archives/C09KPF83TBJ/p1759959559103239`,
the message timestamp and channel ID as `1759959559.103239` and `C09KPF83TBJ` resp.

```shell
curl -X POST https://slack.com/api/chat.delete \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "C09KPF83TBJ",
    "ts": "1759959559.103239"
  }'
```