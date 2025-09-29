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

### API Server

Note: sudo privlieges required

```shell
yarn dev
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

### 2. Spawn Compute Engine VM

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