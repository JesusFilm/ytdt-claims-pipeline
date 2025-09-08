# ytdt-claims-pipeline

Node.js API server.


## Development

### Requisites

1. **OpenVPN** – Setup, start, and test  

Drop `ca.crt`, `client.crt`, `client.key`, `client.ovpn` into `./config/vpn`,  
then install OpenVPN binary and dry-test (one-time):

```shell
brew install openvpn
sudo openvpn --config ./config/vpn/client.ovpn
```

### API Server

Note: sudo privlieges required

```shell
yarn dev
```

### Test Pipeline

Note: sudo privlieges required

```shell
# Using VPN
sudo node scripts/test-pipeline.js

# Using local MySQL
SKIP_VPN=true sudo node scripts/test-pipeline.js
```

**Expected response:**

```text
YouTube MCN Pipeline Test
=========================

=== Testing Individual Steps ===

1. Checking environment variables...
✓ All required environment variables present

2. Checking VPN config...
✓ VPN config file found

3. Testing MySQL connection...
⚠ Skipping MySQL test (requires VPN for remote host)

-----------------------------------
Ready to test full pipeline?
This will create test data in your database.
Press Ctrl+C to cancel, or Enter to continue...

=== Testing Full Pipeline ===

✓ Created test claims file
✓ Created test verdicts file

Starting pipeline with test files...

Running connect_vpn...
VPN connection established
MySQL connected through VPN
✓ connect_vpn completed

Running backup_tables...
Backup created: youtube_mcn_claims_bkup_2025_09_04
✓ backup_tables completed

Running process_claims...
Processed 0/2 claims
✓ process_claims completed

Running process_mcn_verdicts...
✓ process_mcn_verdicts completed

Skipping process_jfm_verdicts - no input file

Running export_views...
Exporting export_all_claims...
Exporting export_owned_videos...
Exporting export_unprocessed_claims...
Exported 3 views
✓ export_views completed

Running enrich_ml...
ML enrichment failed, continuing without ratings: Request failed with status code 403
✓ enrich_ml completed

Running upload_drive...
Would upload all_claims.csv to youtube_exports/20250904
Would upload owned_videos.csv to youtube_exports/20250904
Would upload unprocessed_claims.csv to youtube_exports/20250904
Uploaded 3 files to Google Drive
✓ upload_drive completed

Pipeline completed in 40s
MySQL connection closed
VPN disconnected

✅ Pipeline completed successfully!
Result: {
  "success": true,
  "duration": 40322,
  "outputs": {
    "claimsProcessed": {
      "total": 2,
      "new": 0
    },
    "mcnVerdicts": {
      "processed": 2,
      "invalidMCIDs": 2
    },
    "exports": {
      "export_all_claims": {
        "path": "/Users/ceduth/Devl/Projects/ytdt/ytdt-claims-pipeline/data/exports/all_claims.csv",
        "rows": 513355
      },
      "export_owned_videos": {
        "path": "/Users/ceduth/Devl/Projects/ytdt/ytdt-claims-pipeline/data/exports/owned_videos.csv",
        "rows": 16027
      },
      "export_unprocessed_claims": {
        "path": "/Users/ceduth/Devl/Projects/ytdt/ytdt-claims-pipeline/data/exports/unprocessed_claims.csv",
        "rows": 12968
      }
    },
    "driveUploads": [
      {
        "name": "all_claims.csv",
        "size": 211196213,
        "rows": 513355
      },
      {
        "name": "owned_videos.csv",
        "size": 22062744,
        "rows": 16027
      },
      {
        "name": "unprocessed_claims.csv",
        "size": 5205148,
        "rows": 12968
      }
    ]
  }
}

Test complete!
```

### Docker

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

## Production


### Build image to Registry

* Build image

```shell
docker build . -f infrastructure/Dockerfile -t ytdt-claims-pipeline:latest
```

*  Google Artifact Registry 

```shell
export \
  PROJECT_ID=jfp-data-warehouse \
  IMAGE_URL=us-east1-docker.pkg.dev/$PROJECT_ID/$GAR_REPO/ytdt-claims-pipeline:latest \
  GAR_REPO=ytdt-claims

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

### 2. Spwan Compute Engine VM

* Create COS VM with cloud-config

```shell
envsubst < infrastructure/gcp/cloud-config.template.yaml > infrastructure/gcp/cloud-config.yaml

gcloud compute instances create ytdt-claims-pipeline \
  --image-family=cos-stable \
  --image-project=cos-cloud \
  --metadata-from-file user-data=infrastructure/gcp/cloud-config.yaml \
  --zone=us-east1-b \
  --machine-type=e2-medium \
  --boot-disk-size=20GB
```

* Test

```shell
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