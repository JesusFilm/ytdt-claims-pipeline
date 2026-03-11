# ytdt-claims-pipeline

Node.js API server for processing YouTube MCN claims, verdicts, and exporting data to Google Drive.


## Development

### Prerequisites

1. **MongoDB**

```shell
docker run -d \
  --name mongodb \
  --restart unless-stopped \
  -p 27017:27017 \
  -v mongodb_data:/data/db \
  mongo:6
```

2. **BigQuery** — Service account with BigQuery Data Editor + Job User roles

Download the service account key to `config/service-account-key.json`. This is also used for Google Drive uploads.
The service account (`config/service-account-key.json`) needs:

- **BigQuery Data Editor** + **BigQuery Job User** on the `BQ_DATASET` dataset (read/write pipeline tables)
- **BigQuery Data Viewer** on the `core_analytics_views` dataset (read validation tables)
- **Google Drive** — share the target shared drive with the service account email as a Contributor

3. **Google Drive** — Optional (for `upload_drive` step)

Enable the Google Drive API for the same service account.

4. **YT-Validator** — Invoked during ML Enrichment step

Refer to [setup instructions](https://github.com/matthew-jf/YT-Validator/blob/chore/cli-api-wrapper/README.md).

### Environment

Copy and configure:

```shell
cp src/.env.example .env
```

To generate a JWT secret:
```shell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### API Server

Notes: 
1. Allows up to 8GB JS heap size to run safely via `--max-old-space-size=8192"`

```shell
yarn dev
```

eg. `.vscode/launch.json` for debugging:
```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "pwa-node",
            "request": "launch",
            "name": "Dev (watch mode)",
            "runtimeExecutable": "./node_modules/.bin/nodemon",
            "runtimeArgs": ["--max-old-space-size=8192"],
            "program": "${workspaceFolder}/src/server.js",
            "restart": true,
            "envFile": "${workspaceFolder}/.env",
            "env": {
                "NODE_ENV": "development",
                "GOOGLE_DRIVE_NAME": "youtube_exports",
                "PIPELINE_TIMEOUT_MINUTES": "30"
                // Etc., check src/.env.example
                },
            "console": "integratedTerminal",
            "internalConsoleOptions": "neverOpen",
            "skipFiles": ["<node_internals>/**"]
        }
    ]
}
```


### Test Pipeline: Using API

```shell
BASE_URL="http://localhost:3000"
TEST_DIR="./data/test"
```

* Test 1: Both sources + verdicts
```shell
curl -X POST $BASE_URL/api/run \
  -F "claims_matter_entertainment=@$TEST_DIR/test_claims_matter_entertainment.csv" \
  -F "claims_matter_2=@$TEST_DIR/test_claims_matter_2.csv" \
  -F "mcn_verdicts=@$TEST_DIR/test_mcn_verdicts.csv" \
  -F "jfm_verdicts=@$TEST_DIR/test_jfm_verdicts.csv"
```

* Test 2: Only matter_entertainment
```shell
curl -X POST $BASE_URL/api/run \
  -F "claims_matter_entertainment=@$TEST_DIR/test_claims_matter_entertainment.csv" \
  -F "mcn_verdicts=@$TEST_DIR/test_mcn_verdicts.csv"
```

* Test 3: Only matter_2
```shell
curl -X POST $BASE_URL/api/run \
  -F "claims_matter_2=@$TEST_DIR/test_claims_matter_2.csv" \
  -F "mcn_verdicts=@$TEST_DIR/test_mcn_verdicts.csv"
```

* Test 4: Check status

```shell
curl http://localhost:3000/api/status
```

### Test Pipeline: Using supplied script

```shell
node scripts/test-pipeline.js
```


## Production

See [docs/deploy.md](./docs/deploy.md).


## Integrations

### [Slack Notification Bot](./docs/slack-integration.md)

```
Pipeline Complete → Check Status → Post to #youtube-data-chat
                                         ↓
                              [Failed? Add "Rerun" button]
                                         ↓
User Clicks "Rerun" → Slack Interaction → Backend Webhook → Trigger New Pipeline Run
```