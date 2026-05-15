# Pending Runs — Claims & Verdicts Split Flow

## Overview

Claims files (~1GB each) are too large to upload via Slack. Verdicts are small and uploaded by Ben via Slack. This doc explains how the two are coordinated.

## Flow

```
Data Engineering uploads claims via UI
          ↓
    💾 Save & Wait for Verdicts
          ↓
   Stored as pending_run in MongoDB (status: awaiting_verdicts)
          ↓
Ben runs /run-claims in Slack → prompted for verdicts only
          ↓
Bot detects pending claims → merges with verdicts → fires pipeline
          ↓
Notification posted to #ytdt-pipeline with 📁 Drive link
```

## UI — Two Modes

### Mode 1: Full Pipeline (existing)
Upload all 4 files → **▶ Run Pipeline** → fires immediately.

### Mode 2: Save & Wait for Verdicts (new)
Upload claims only (ME + M2) → **💾 Save & Wait for Verdicts** → stored as `pending_run`, pipeline does not start.

A banner appears when pending claims exist:
```
⚠️ Pending claims from [date] — awaiting verdicts
[ ▶ Resume: Upload Verdicts ]  [ 🗑 Clear ]
```

- **Resume: Upload Verdicts** — opens upload form pre-filled with pending claims; add verdicts and hit Run Pipeline
- **Clear** — discards the pending run

## Slack — Verdicts Only

When Ben runs `/run-claims`, the bot skips claims steps and only prompts for:
- Step 1 of 2: MCN Verdicts
- Step 2 of 2: JFM Verdicts

On submission, the bot checks for a `pending_run` with `status: awaiting_verdicts`:
- **Found** → merges claims + verdicts → runs pipeline
- **Not found** → _"No claims are currently staged. Please check with the data team."_

## Data Model

```json
{
  "_id": "...",
  "status": "awaiting_verdicts",
  "claims": {
    "matter_entertainment": "data/uploads/...",
    "matter_2": "data/uploads/..."
  },
  "uploadedAt": "2026-05-14T19:00:00Z",
  "uploadedBy": "edouard"
}
```

Stored in the `pending_runs` MongoDB collection. Only one pending run is allowed at a time.