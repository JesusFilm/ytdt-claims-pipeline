# Slack Integration Setup

## Required Permissions

### Bot Token Scopes
- `chat:write` - Post messages to channels
- `chat:write.public` - Post to channels without joining

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

### 3. Enable Interactivity

1. Navigate to **Interactivity & Shortcuts**
2. Turn on **Interactivity**
3. Set **Request URL**: `https://<backend-url>/api/slack/interactions`
4. Click **Save Changes**

### 4. Install App to Workspace

1. Navigate to **Install App**
2. Click **Install to Workspace**
3. Authorize the app
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 5. Get Signing Secret

1. Navigate to **Basic Information**
2. Under **App Credentials**, copy the **Signing Secret**

### 6. Configure Environment Variables

Add to your `.env` file:

```bash
SLACK_BOT_TOKEN=xoxb-bot-token-here
SLACK_SIGNING_SECRET=bot-signing-secret-here
SLACK_CHANNEL=#youtube-data-chat
```

### 7. Invite Bot to Channel

In Slack:
1. Go to your target channel (`#youtube-data-chat`)
2. Type `/invite @Pipeline Notifier`

Or the bot will auto-post using `chat:write.public` scope.

## Testing

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

**Button clicks not working:**
- Verify Request URL is publicly accessible
- Check backend logs for errors
- Ensure HTTPS is used (Slack requires HTTPS)

**Delete Bots's own messages:** 

Eg., where `1759627249.686209` is message timestamp,
and `G010SG5QV9B` is channel ID.

```shell
curl -X POST https://slack.com/api/chat.delete \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "G010SG5QV9B",
    "ts": "1759627249.686209"
  }'
```

