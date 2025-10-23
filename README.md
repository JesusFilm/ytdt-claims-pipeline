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


## Production (Google Cloud Run)

Every Cloud Run service gets a secure HTTPS endpoint with a valid SSL certificate. No configuration needed.

### Deployment env vars set (not the project envs)

```shell
export \
  PROJECT_ID=jfp-data-warehouse \
  SERVICE_ACCOUNT=ceduth-jfp-dev@jfp-data-warehouse.iam.gserviceaccount.com \
  GAR_REPO=ytdt-claims 

export \
  IMAGE_URL=us-east1-docker.pkg.dev/$PROJECT_ID/$GAR_REPO/ytdt-claims-pipeline:latest 
```

### 1. Database setup

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

**Step 2) Make MongoDB accessible from Cloud Run Cloud**

* Private GCE IPs are not accessible from Cloud Run without VPC connector!

```shell
gcloud compute networks vpc-access connectors create ytdt-connector \
  --network default \
  --region us-east1 \
  --range 10.8.0.0/28
```

* `--range 10.8.0.0/28` below is an IP range for the VPC connector that shouldn't overlap with our existing subnets.
Check your existing subnets to find a safe range:
```shell
gcloud compute networks subnets list --network=default
```

**Step 3) Set MONGODB_URI env to production database**

Set `MONGODB_URI=mongodb://<INTERNAL_IP>:27017/ytdt-pipeline` in `.env.production`.
Get internal VM IP from:
```shell
gcloud compute instances describe ytdt-mongodb 
```

### 2. Setup Googole Artifact repository permissions

```shell
# Optionally set SA to existing VM
gcloud compute instances set-service-account ytdt-claims-pipeline \
  --service-account=ceduth-jfp-dev@jfp-data-warehouse.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --zone=us-east1-b

# Give the artifact repo read permission for the service account
gcloud artifacts repositories add-iam-policy-binding ytdt-claims \
  --location=us-east1 \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/artifactregistry.reader"

# Verify service account permissions
gcloud artifacts repositories get-iam-policy ytdt-claims \
  --location=us-east1

# Ensure Service Account is attached to the VM
gcloud compute instances describe ytdt-claims-pipeline --zone=us-east1-b |grep $SERVICE_ACCOUNT 
```

### 3. Build backend image to Registry

* Build image

```shell
docker buildx build --platform linux/amd64 -f infrastructure/Dockerfile -t ytdt-claims-pipeline:latest .
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

*  Publish image to Google Artifact Registry 

```shell
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

* Store secrets in GCP Secret Manager (one-time setup)**

```shell
# Enable Secrets Manager API
gcloud services enable secretmanager.googleapis.com

# Create secrets from .env.production variables
echo -n "$MYSQL_PASSWORD" | gcloud secrets create mysql-password --data-file=-
echo -n "$SLACK_BOT_TOKEN" | gcloud secrets create slack-bot-token --data-file=-
echo -n "$SLACK_SIGNING_SECRET" | gcloud secrets create slack-signing-secret --data-file=-
gcloud secrets create vpn-config --data-file="$VPN_CONFIG_FILE"

# Grant the service account access to all secrets (by project admin)
for secret in mysql-password slack-bot-token slack-signing-secret vpn-config; do
  gcloud secrets add-iam-policy-binding $secret \
    --member="serviceAccount:$SERVICE_ACCOUNT" \
    --role="roles/secretmanager.secretAccessor"
done

# Ensure access is granted
for secret in mysql-password slack-bot-token slack-signing-secret vpn-config; do
  gcloud secrets get-iam-policy $secret
done
```

### 4. Deploy to Google Cloud Run 

* Export project envs to shell for pickup by the gcloud binary

```shell
# Create production env file with proper envs and brand new JWT_SECRET:
# JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
cp src/.env.example .env.production

# Export to shell
set -a && source .env.production && set +a
```

* Deploy

```shell
# Create the VM (needs re-creation if template edited)
gcloud run deploy ytdt-claims-pipeline \
  --image us-east1-docker.pkg.dev/jfp-data-warehouse/ytdt-claims/ytdt-claims-pipeline:latest \
  --platform managed \
  --region us-east1 \
  --port 3000 \
  --vpc-connector ytdt-connector \
  --service-account $SERVICE_ACCOUNT \
  --set-env-vars NODE_ENV=$NODE_ENV,MONGODB_URI=$MONGODB_URI,MYSQL_HOST=$MYSQL_HOST,MYSQL_USER=$MYSQL_USER,MYSQL_DATABASE=$MYSQL_DATABASE \
  --set-secrets MYSQL_PASSWORD=mysql-password:latest,SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing-secret:latest \
  --allow-unauthenticated
```

* Track the URL of deployed microservice 
```shell
BACKEND_URL=$(gcloud run services describe ytdt-claims-pipeline --region us-east1 --format 'value(status.url)')
```

### 6. (Optional) Update the deployment with additional environment variables

Feg., this backend has the following external (optional) services dependencies:

```shell
# Safe, won't override existing envs
gcloud run services update ytdt-claims-pipeline --region us-east1 \
  --update-env-vars \
ML_API_ENDPOINT=$(gcloud run services describe yt-validator --region us-east1 --format 'value(status.url)'),\
FRONTEND_URL=$FRONTEND_URL,\
GOOGLE_REDIRECT_URI=$BACKEND_URL/api/auth/google/callback,\
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET,\
SLACK_CHANNEL=$SLACK_CHANNEL
```
ML_API_ENDPOINT=

### 7. Test Deployment

* Without Public Access

Uses `gcloud auth print-identity-token` that generates/uses an identity token that proves to Cloud Run that 
the request is from an authenticated Google user or service account.

```shell
# Test with Google-signed JWT token generated for the current user/service account
curl $BACKEND_URL/api/health -H "Authorization: bearer $(gcloud auth print-identity-token)"
```

* Make publicly accessible (Frontend elsewhere than GCP)

```shell
gcloud run services add-iam-policy-binding ytdt-claims-pipeline \
  --region=us-east1 \
  --member="allUsers" \
  --role="roles/run.invoker"
```
Or `Service Details > Security > Authentication > "Allow public access"` in Google Console.
Nota: Project Admin required!

* Inspect envs (yay! can't show secrets)
```shell
gcloud run services describe ytdt-claims-pipeline --region us-east1 --format=json | jq -r '.spec.template.spec.containers[0].env[]'
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