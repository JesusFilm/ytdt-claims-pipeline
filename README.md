# ytdt-claims-pipeline

Node.js API server.


## Development

### Requisites

1. **MongoDB** 

```shell
docker run -d \
  --name mongodb \
  --restart unless-stopped \
  -p 27017:27017 \
  -v mongodb_data:/data/db \
  mongo:6
```

2. **OpenVPN** – Setup, start, and test  

+Drop `ca.crt`, `client.crt`, `client.key`, `client.ovpn` into `./config/vpn`.  
+See [VPN troubleshooting](./docs/vpn-troubleshooting.md) for required directives and credential rotation.  
 then install OpenVPN binary and dry-test (one-time):

```shell
brew install openvpn
sudo openvpn --config ./config/vpn/client.ovpn
mkdir logs/
```

3. **Google Drive** - Optional (for `upload_drive` step)

- Create Service Account on GCP and download to `config/service-account-key.json`
- Enable the Google Drive API

4. **YT-Validator** - Inovked during ML Enrichment step

Refer to [setup instructions](https://github.com/matthew-jf/YT-Validator/blob/chore/cli-api-wrapper/README.md).

### API Server

Notes: 
1. Requies sudo privileges to spawn the VPN client.
2. Allow up to 8GB JS heap size to run safely `--max-old-space-size=8192"`

```shell
export \

  # Optional envs
  GOOGLE_DRIVE_NAME=youtube_exports 

yarn dev
```

eg. `.vscode/launch.json`for debugging:
```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "pwa-node",
            "request": "launch",
            "name": "Dev (watch mode)",
            "runtimeExecutable": "sudo",
            "runtimeArgs": [ "-E", "./node_modules/.bin/nodemon", "--max-old-space-size=8192" ],
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
            "skipFiles": [
                "<node_internals>/**"
            ]
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

* Test 4: Score unprocessed claims only — no uploads

Runs a subset of steps, exporting whatever is currently `verdict='U'` and
scoring it, skipping the import and verdict steps. This is what the console's
**Score Unprocessed Claims** button posts. Omit `steps` for the full pipeline.

```shell
curl -X POST $BASE_URL/api/run \
  -F "steps=connect_vpn,export_views,enrich_ml,upload_drive"
```

Unknown step names are rejected with 400 and the valid list returned.

* Test 5: Check status

```shell
curl http://localhost:3000/api/status
```

```sql
SELECT claim_report_source, COUNT(*) 
FROM youtube_mcn_claims 
GROUP BY claim_report_source;
```

### Test Pipeline: Using supplied script (generates test data)

```shell
# Using VPN
sudo node scripts/test-pipeline.js

# Using local MySQL
SKIP_VPN=true sudo node scripts/test-pipeline.js
```


## Production - Google Cloud Engine (GCE)

### 1. Deploy database

**Step 1) Create MongoDB VM on Google Cloud Engine (GCE)**

```shell
gcloud compute instances create ytdt-mongodb \
  --image-family=cos-stable \
  --image-project=cos-cloud \
  --metadata-from-file user-data=infrastructure/gcp/cloud-config-mongodb.yaml \
  --zone=us-east1-b \
  --machine-type=e2-small \
  --boot-disk-size=30GB
```

**Step 2) Set MONGODB_URI env to production database**

Set `MONGODB_URI=mongodb://<INTERNAL_IP>:27017/ytdt-pipeline` in `.env.production`.
Get internal VM IP from:
```shell
gcloud compute instances describe ytdt-mongodb 
```

### 2. [Deploy ytdt-claims-pipeline](./docs/deploy.md) to GCE.


## Frontend

The web UI is in [JesusFilm/ytdt-claims-console](https://github.com/JesusFilm/ytdt-claims-console).


## Integrations

### [Slack Bot](./docs/slack-integration.md)

Notifications:

```
Pipeline Complete → Check Status → Post to #youtube-data-chat
                                         ↓
                              [Failed? Add "Rerun" button]
                                         ↓
User Clicks "Rerun" → Slack Interaction → Backend Webhook → Trigger New Pipeline Run
```

Guided upload:

```
/run-verdicts → Guided CSV Upload (4 steps) → ▶ Run Pipeline → Pipeline Runs
                                                                      ↓
                                             Notification posted to #youtube-data-chat
                                                                      ↓
                                                   [📁 View in Drive] / [Rerun Pipeline]
```

### [Pending Runs — Claims & Verdicts Split](./docs/pending-runs.md)

Ben uploads verdicts via Slack. Claims now arrive automatically (below), so staging them by hand is the fallback. The pipeline fires once both are present.

### [Daily Claims Ingest — YouTube Reporting API](./docs/claims-reporting-api.md)

Claims reports load daily from the YouTube Reporting API into `youtube_mcn_claims`, then refresh YT-Validator's ASR queue.
