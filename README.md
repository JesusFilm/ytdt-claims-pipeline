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

Drop `ca.crt`, `client.crt`, `client.key`, `client.ovpn` into `./config/vpn`,  
then install OpenVPN binary and dry-test (one-time):

```shell
brew install openvpn
sudo openvpn --config ./config/vpn/client.ovpn
```

3. **Google Drive** - Optional (for `upload_drive` step)

- Create Service Account on GCP and download to `config/service-account-key.json`
- Enable the Google Drive API


### API Server

Note: sudo privlieges required

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
            "runtimeArgs": [ "-E", "./node_modules/.bin/nodemon" ],
            "program": "${workspaceFolder}/src/api.js",
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
curl -X POST http://localhost:3000/api/pipeline/run \
  -F "claims=@/path/to/claims.csv" \
  -F "mcnVerdicts=@/path/to/mcn_verdicts.csv" \
  -F "jfmVerdicts=@/path/to/jfm_verdicts.csv"
```

### Test Pipeline: Using supplied script (generates test data)

```shell
# Using VPN
sudo node scripts/test-pipeline.js

# Using local MySQL
SKIP_VPN=true sudo node scripts/test-pipeline.js
```


## Production


### Build image to Registry

* Build image

```shell
docker build . -f infrastructure/Dockerfile -t ytdt-claims-pipeline:latest
```

* Test container locally

```shell
docker run -d \
  --privileged \
  --cap-add=NET_ADMIN \
  --cap-add=SYS_ADMIN \
  -v /path/to/vpn-config:/config/vpn \
  -p 3000:3000 \
  --env-file .env \
  ytdt-claims-pipeline
```

*  Google Artifact Registry 

```shell
export \
  PROJECT_ID=jfp-data-warehouse \
  SERVICE_ACCOUNT=ceduth-jfp-dev@jfp-data-warehouse.iam.gserviceaccount.com \
  GAR_REPO=ytdt-claims \
  IMAGE_URL=us-east1-docker.pkg.dev/$PROJECT_ID/$GAR_REPO/ytdt-claims-pipeline:latest 

# Configure Docker for Google Artifact Registry (one-time setup)
gcloud config set project $PROJECT_ID
gcloud auth configure-docker us-east1-docker.pkg.dev

# Create repository (one-time setup)
gcloud artifacts repositories create $GAR_REPO \
  --repository-format=docker \
  --location=us-east1

# Tag and push to GAR
docker tag ytdt-claims-pipeline:latest $IMAGE_URL
docker push $IMAGE_URL
```

* Push to GitHub Container Registry (alternative)

```shell
export \
  GHCR_USER=ceduth-jfp 
  
# Tag 
docker tag ytdt-claims-pipeline:latest ghcr.io/$GHCR_USER/ytdt-claims-pipeline:latest 

# And push to GCR
gh auth token | docker login ghcr.io -u $GHCR_USER --password-stdin
docker push ghcr.io/$GHCR_USER/ytdt-claims-pipeline:latest
```

### 2. Spawn Compute Engine VM (COS)

**Step 1) Export environment variables from env for cloud-config**

```shell
set -a && source .env && set +a
```

**Step 2) Store secrets in GCP Secret Manager (one-time setup)**

```shell

# Enable Secrets Manager API
# gcloud services enable secretmanager.googleapis.com
# Create secrets from .env variables
echo -n "$MYSQL_PASSWORD" | gcloud secrets create mysql-password --data-file=-
echo -n "$SLACK_BOT_TOKEN" | gcloud secrets create slack-bot-token --data-file=-
echo -n "$SLACK_SIGNING_SECRET" | gcloud secrets create slack-signing-secret --data-file=-
gcloud secrets create vpn-config --data-file="$VPN_CONFIG_FILE"
```

**Step 3) Create COS VM with cloud-config**

```shell

# Create cloud-config.yaml instance template
envsubst < infrastructure/gcp/cloud-config.template.yaml > infrastructure/gcp/cloud-config.yaml

# Create the VM (needs re-creation if template edited)
gcloud compute instances create ytdt-claims-pipeline \
  --image-family=cos-stable \
  --image-project=cos-cloud \
  --metadata-from-file user-data=infrastructure/gcp/cloud-config.yaml \
  --service-account=$SERVICE_ACCOUNT \
  --scopes=cloud-platform \
  --zone=us-east1-b \
  --machine-type=e2-medium \
  --boot-disk-size=20GB

# Optionally set SA to existing VM
# gcloud compute instances set-service-account ytdt-claims-pipeline \
#   --service-account=ceduth-jfp-dev@jfp-data-warehouse.iam.gserviceaccount.com \
#   --scopes=https://www.googleapis.com/auth/cloud-platform \
#   --zone=us-east1-b

# Give the artifact repo read permission for the service account
gcloud artifacts repositories add-iam-policy-binding ytdt-claims \
  --location=us-east1 \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/artifactregistry.reader"
```

* Test

```shell

# Get public IP
gcloud compute instances list --zones=us-east1-b
gcloud compute instances describe INSTANCE_NAME --zone=us-east1-bRetry

# Test the API is accessible
curl http://EXTERNAL_IP/api/health
```

### 3. Manage Compute Engine VM

* Restart the entire VM feg. after new image push (Optional)

```shell
gcloud compute instances reset ytdt-claims-pipeline
```

* Delete current VM

```shell
gcloud compute instances delete ytdt-claims-pipeline 
```

* SSH into the VM

```shell
gcloud compute ssh ytdt-claims-pipeline --zone=us-east1-b
sudo journalctl -u ytdt-claims-pipeline.service -n 50 --no-pager

```

* After SSH into the VM

```shell

# Since gcloud not directly available to COS images
alias gcloud=docker run --rm -it google/cloud-sdk:slim gcloud

# Stop and remove old container
sudo docker stop ytdt-claims-pipeline
sudo docker rm ytdt-claims-pipeline

# Pull latest image
PROJECT_ID=jfp-data-warehouse
sudo docker pull us-east1-docker.pkg.dev/$PROJECT_ID/ytdt-claims-pipeline/ytdt-claims-pipeline:latest

# Restart the service (which will use new image)
sudo systemctl restart ytdt-claims-pipeline.service

# Check status
sudo systemctl status ytdt-claims-pipeline.service

# Check detailed logs
sudo journalctl -u ytdt-claims-pipeline.service -f

```

## Integrations

### [Slack Notification Bot](./docs/slack-integration.md)

```
Pipeline Complete → Check Status → Post to #youtube-data-chat
                                         ↓
                              [Failed? Add "Rerun" button]
                                         ↓
User Clicks "Rerun" → Slack Interaction → Backend Webhook → Trigger New Pipeline Run
```