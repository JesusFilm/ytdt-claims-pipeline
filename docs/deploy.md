# Production — Google Compute Engine (GCE)

## 1. Deploy database

**Step 1) Create MongoDB VM**

```shell
gcloud compute instances create ytdt-mongodb \
  --image-family=cos-stable \
  --image-project=cos-cloud \
  --metadata-from-file user-data=infrastructure/gcp/cloud-config-mongodb.yaml \
  --zone=us-east1-b \
  --machine-type=e2-small \
  --boot-disk-size=30GB
```

**Step 2) Make MongoDB accessible from Cloud Run**

Private GCE IPs are not accessible from Cloud Run without VPC connector:

```shell
gcloud compute networks vpc-access connectors create ytdt-connector \
  --network default \
  --region us-east1 \
  --range 10.8.0.0/28
```

`--range 10.8.0.0/28` is an IP range for the VPC connector that shouldn't overlap with existing subnets.
Check your existing subnets to find a safe range:

```shell
gcloud compute networks subnets list --network=default
```

**Step 3) Set MONGODB_URI**

Set `MONGODB_URI=mongodb://<INTERNAL_IP>:27017/ytdt-pipeline` in `.env.production`.
Get internal VM IP from:

```shell
gcloud compute instances describe ytdt-mongodb
```

## 2. Deploy ytdt-claims-pipeline

### Deployment Configuration

This deployment uses **local source code** and **local configuration** — no GitHub, no Secret Manager.

The deploy script (`infrastructure/gcp/deploy.sh`):

1. Loads all environment variables from `.env.production` (including secrets)
2. Creates source code tarball and uploads to GCS
3. Replaces all placeholders in `cloud-config.yaml` with actual values from `./.env.production`
4. Deploys Ubuntu VM with the populated cloud-config

The VM provisioning (`cloud-config.yaml`):

1. Installs dependencies: Node.js v20, Nginx, Miniconda
2. Downloads and extracts ytdt-claims-pipeline source from GCS
3. Runs `npm install`
4. Clones YT-Validator repo and creates conda environment
5. Gets external IP and creates domain (`<IP>.nip.io`)
6. Creates `/etc/ytdt-claims-pipeline/.env` with all pre-populated variables from deploy script
7. Appends dynamic variables to `/etc/ytdt-claims-pipeline/.env`:
   - BASE_URL (http/https based on SSL status)
   - ML_API_ENDPOINT (http://localhost:3001)
   - GOOGLE_REDIRECT_URI (includes protocol based on SSL)
8. Configures Nginx as reverse proxy with SSL via Let's Encrypt
9. Sets up SSL auto-renewal cron job
10. Creates systemd services:
    - **yt-validator**: Creates `/opt/yt-validator/.env` with BASE_URL and YT_API_KEY
    - **ytdt-claims-pipeline**: Sources `/etc/ytdt-claims-pipeline/.env` before starting
11. Starts both services

All secrets and configuration come from `.env.production`.

### Prerequisites

- `gcloud` CLI installed and authenticated
- `.env.production` file with **all** required environment variables including secrets
  from both `ytdt-claims-pipeline` (see `src/.env.example`) and `YT-Validator`.
- `config/` directory with:
  - `config/service-account-key.json` (Google service account for BigQuery and Drive access)

### Deploy

```bash
# Env variables - Cf. `infrastructure/gcp/deploy.sh`.
# 1. **deploy.sh** reads environment variables (or uses defaults)
# 2. Passes them as VM metadata during instance creation
# 3. **cloud-config.yaml** reads from GCP metadata service
# 4. Uses the values during setup
export SSL_EMAIL="edouard.carvalho@p2c.com"
export LETSENCRYPT_STAGING="--staging"

# From project root
./infrastructure/gcp/deploy.sh
```

## 3. Load historical BigQuery data (only once, gets updated by verdict work)

Upload the MCN claims export to GCS and load into BigQuery:
```shell
gsutil cp youtube_mcn_claims_YYYYMMDD.csv gs://ytdt-claims/

bq load --max_bad_records=0 --source_format=CSV \
  --field_delimiter='|' --quote='"' --allow_quoted_newlines \
  --skip_leading_rows=1 \
  --schema config/schemas/youtube_mcn_claims_schema.json \
  <BQ_DATASET>.youtube_mcn_claims gs://ytdt-claims/youtube_mcn_claims_YYYYMMDD.csv
```

## Troubleshooting

### Verifying Configuration

* View the configuration used in last deployment:

```bash
# SSH to VM
gcloud compute instances describe ytdt-claims --zone=us-east1-b \
  --format='table(metadata.items:format="table(key,value)")'
```

* After deployment, check the setup used:

```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b

# Check metadata
curl -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/ssl-email

curl -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/yt-validator-repo

curl -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/yt-validator-branch

# Check what was cloned
cd /opt/yt-validator
git remote -v
git branch
```

### Editing Configuration

The VM metadata is set at creation time. To change:
1. Delete the VM: `gcloud compute instances delete ytdt-claims --zone=us-east1-b`
2. Set new environment variables
3. Redeploy: `./infrastructure/gcp/deploy.sh`

### SSL Certificate Fails

- Check logs: `sudo cat /var/log/letsencrypt/letsencrypt.log`
- Deploy certificate manually, eg. 
```shell
sudo rm -rf /etc/letsencrypt/accounts
sudo certbot --nginx -d 35.227.61.101.nip.io --non-interactive --agree-tos --email me@ceduth.dev --redirect
```

### Check systemd service issues

SSH into the VM and run these commands:

1. Check current status
```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b
```

2. View full cloud-init log to see where setup failed
```bash
sudo cat /var/log/cloud-init-output.log | tail -100
```

3. Check if Docker was installed
```bash
docker --version
sudo systemctl status docker
```

4. Check if setup script completed
```bash
sudo journalctl -u cloud-final -n 100
```

5. If setup failed early, run manually:
```bash
sudo /usr/local/bin/setup-vm.sh
```

6. After setup completes, check service status:
```bash
sudo systemctl status ytdt-claims-pipeline
sudo systemctl status yt-validator
```

7. If services still fail, check their logs:
```bash
sudo journalctl -u ytdt-claims-pipeline -n 50
sudo journalctl -u yt-validator -n 50
```
