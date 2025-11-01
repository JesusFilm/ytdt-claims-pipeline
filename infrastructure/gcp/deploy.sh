#!/bin/bash
set -e

# Deployment script for ytdt-claims-pipeline + YT-Validator on single GCE VM
# with SSL support via Let's Encrypt
# Usage:
#   gcloud compute instances delete ytdt-claims --zone=us-east1-b && \
#   chmod +x ./infrastructure/gcp/deploy.sh && ./infrastructure/gcp/deploy.sh

# ============================================================================
# Configuration
# ============================================================================

# Define log function first
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

export ENV_FILE=${ENV_FILE:-".env.production"}
export PROJECT_ID=${PROJECT_ID:-"jfp-data-warehouse"}
export SERVICE_ACCOUNT=${SERVICE_ACCOUNT:-"ceduth-jfp-dev@jfp-data-warehouse.iam.gserviceaccount.com"}
export ZONE=${ZONE:-"us-east1-b"}
export VM_NAME=${VM_NAME:-"ytdt-claims"}
export MACHINE_TYPE=${MACHINE_TYPE:-"e2-standard-4"}
export BOOT_DISK_SIZE=${BOOT_DISK_SIZE:-"50GB"}

# YT-Validator Configuration
export YT_VALIDATOR_REPO=${YT_VALIDATOR_REPO:-"https://github.com/matthew-jf/YT-Validator.git"}
export YT_VALIDATOR_BRANCH=${YT_VALIDATOR_BRANCH:-"chore/cli-api-wrapper"}

# SSL Certificate Email
export SSL_EMAIL=${SSL_EMAIL:-"me@ceduth.dev"}
export LETSENCRYPT_STAGING=${LETSENCRYPT_STAGING:-""}

# Load environment variables from .env.production
if [ -f "$ENV_FILE" ]; then
    log "Loading environment variables from $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
else
    log "WARNING: $ENV_FILE not found. Using default values."
fi

# ============================================================================
# Functions
# ============================================================================

check_prerequisites() {
    log "Checking prerequisites..."
    
    if ! command -v gcloud &> /dev/null; then
        echo "ERROR: gcloud CLI not found. Please install it first."
        exit 1
    fi
    
    log "Prerequisites OK"
}

upload_source_code() {
    log "Preparing source code for deployment..."
    
    BUCKET_NAME="ytdt-claims"
    
    # Create bucket if it doesn't exist
    if ! gsutil ls -b gs://${BUCKET_NAME} &> /dev/null; then
        log "Creating GCS bucket: ${BUCKET_NAME}"
        gsutil mb -p ${PROJECT_ID} -l us-east1 gs://${BUCKET_NAME}
    fi
    
    # Create tarball of source code (including config/ directory)
    log "Creating tarball of ytdt-claims-pipeline..."
    tar -czf /tmp/ytdt-claims-pipeline.tar.gz \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='.env*' \
        --exclude='data/uploads' \
        --exclude='data/exports' \
        --exclude='*.log' \
        .
    
    # Upload to GCS
    log "Uploading source code to GCS..."
    gsutil cp /tmp/ytdt-claims-pipeline.tar.gz gs://${BUCKET_NAME}/ytdt-claims-pipeline.tar.gz
    gsutil iam ch serviceAccount:${SERVICE_ACCOUNT}:objectViewer gs://${BUCKET_NAME}
    
    # Cleanup
    rm /tmp/ytdt-claims-pipeline.tar.gz
    
    log "Source code uploaded successfully"
}

create_vm() {
    log "Creating VM: ${VM_NAME}..."
    
    # Check if VM already exists
    if gcloud compute instances describe ${VM_NAME} --zone=${ZONE} &> /dev/null; then
        log "VM ${VM_NAME} already exists. Skipping creation."
        return
    fi
    
    # Create firewall rules if needed
    if ! gcloud compute firewall-rules describe allow-http &> /dev/null; then
        log "Creating firewall rule for HTTP..."
        gcloud compute firewall-rules create allow-http \
            --allow=tcp:80 \
            --target-tags=http-server \
            --description="Allow HTTP traffic"
    fi
    
    if ! gcloud compute firewall-rules describe allow-https &> /dev/null; then
        log "Creating firewall rule for HTTPS..."
        gcloud compute firewall-rules create allow-https \
            --allow=tcp:443 \
            --target-tags=https-server \
            --description="Allow HTTPS traffic"
    fi
    
    # Create temp cloud-config with actual values from .env.production
    log "Creating cloud-config with environment variables..."
    TEMP_CLOUD_CONFIG=$(mktemp)
    cp ./infrastructure/gcp/cloud-config.yaml "$TEMP_CLOUD_CONFIG"
    
    # Replace placeholders with actual values (using @ delimiter to avoid issues with / in URLs)
    # Skips BASE_URL, ML_API_ENDPOINT which should be the VM's actual URL, not preset from env file
    sed -i "" "s#__NODE_ENV__#${NODE_ENV:-production}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__PORT__#${PORT:-3000}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__MONGODB_URI__#${MONGODB_URI}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__JWT_SECRET__#${JWT_SECRET}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__PIPELINE_TIMEOUT_MINUTES__#${PIPELINE_TIMEOUT_MINUTES:-30}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__SKIP_VPN__#${SKIP_VPN:-false}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__FRONTEND_URL__#${FRONTEND_URL}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__MYSQL_HOST__#${MYSQL_HOST}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__MYSQL_USER__#${MYSQL_USER}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__MYSQL_PASSWORD__#${MYSQL_PASSWORD}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__MYSQL_DATABASE__#${MYSQL_DATABASE:-jfp_analytics_prod}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__VPN_CONFIG_FILE__#${VPN_CONFIG_FILE:-/etc/openvpn/client/client.ovpn}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__VPN_AUTH_FILE__#${VPN_AUTH_FILE:-/etc/openvpn/client/auth.txt}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__EXPORT_FOLDER_NAME_FORMAT__#${EXPORT_FOLDER_NAME_FORMAT:-MMM d yyyy hh:mm:ss a}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__GOOGLE_DRIVE_NAME__#${GOOGLE_DRIVE_NAME:-youtube_exports}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__SLACK_CHANNEL__#${SLACK_CHANNEL}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__SLACK_BOT_TOKEN__#${SLACK_BOT_TOKEN}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__SLACK_SIGNING_SECRET__#${SLACK_SIGNING_SECRET}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__GOOGLE_CLIENT_ID__#${GOOGLE_CLIENT_ID}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__GOOGLE_CLIENT_SECRET__#${GOOGLE_CLIENT_SECRET}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__GOOGLE_WORKSPACE_DOMAINS__#${GOOGLE_WORKSPACE_DOMAINS}#g" "$TEMP_CLOUD_CONFIG"
    sed -i "" "s#__YT_API_KEY__#${YT_API_KEY}#g" "$TEMP_CLOUD_CONFIG"
    
    # Create VM with cloud-config
    log "Creating VM with configuration:"
    log "  YT-Validator Repo: ${YT_VALIDATOR_REPO}"
    log "  YT-Validator Branch: ${YT_VALIDATOR_BRANCH}"
    log "  SSL Email: ${SSL_EMAIL}"
    log "  Source: Local (uploaded to GCS)"
    
    gcloud compute instances create ${VM_NAME} \
        --zone=${ZONE} \
        --machine-type=${MACHINE_TYPE} \
        --boot-disk-size=${BOOT_DISK_SIZE} \
        --image-family=ubuntu-2204-lts \
        --image-project=ubuntu-os-cloud \
        --service-account=${SERVICE_ACCOUNT} \
        --scopes=https://www.googleapis.com/auth/cloud-platform \
        --tags=http-server,https-server \
        --metadata-from-file=user-data="$TEMP_CLOUD_CONFIG" \
        --metadata=enable-oslogin=TRUE,\
yt-validator-repo=${YT_VALIDATOR_REPO},\
yt-validator-branch=${YT_VALIDATOR_BRANCH},\
ssl-email=${SSL_EMAIL},\
letsencrypt-staging=${LETSENCRYPT_STAGING},\
project-id=${PROJECT_ID}
    
    # Clean up temp file
    rm "$TEMP_CLOUD_CONFIG"
    
    log "VM created successfully"
}

get_vm_info() {
    log "Getting VM information..."
    
    EXTERNAL_IP=$(gcloud compute instances describe ${VM_NAME} \
        --zone=${ZONE} \
        --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
    
    DOMAIN="${EXTERNAL_IP}.nip.io"
    
    log "External IP: ${EXTERNAL_IP}"
    log "Domain: ${DOMAIN}"
    log "Access URL: http://${DOMAIN} (HTTPS after SSL setup completes)"
}

wait_for_services() {
    log "Waiting for services to start (this may take 5-10 minutes)..."
    log "The VM is installing Node.js, Miniconda, npm packages, and obtaining SSL certificate..."
    
    local max_attempts=60
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        # Try HTTP first (before SSL)
        if curl -s -o /dev/null -w "%{http_code}" "http://${DOMAIN}/api/health" | grep -q "200"; then
            echo ""
            log "Services are ready on HTTP!"
            return 0
        fi
        
        # Try HTTPS (after SSL)
        if curl -k -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/health" | grep -q "200"; then
            echo ""
            log "Services are ready on HTTPS!"
            return 0
        fi
        
        attempt=$((attempt + 1))
        echo -n "."
        sleep 10
    done
    
    echo ""
    log "WARNING: Services did not become ready in time. Check VM logs:"
    log "  gcloud compute ssh ${VM_NAME} --zone=${ZONE}"
    log "  sudo cat /var/log/cloud-init-output.log"
    log "  sudo journalctl -u ytdt-claims-pipeline -f"
    log "  sudo journalctl -u yt-validator -f"
}

display_summary() {
    echo ""
    echo "============================================================================"
    echo "Deployment Complete!"
    echo "============================================================================"
    echo ""
    echo "Configuration:"
    echo "  YT-Validator Repo: ${YT_VALIDATOR_REPO}"
    echo "  YT-Validator Branch: ${YT_VALIDATOR_BRANCH}"
    echo "  YTDT Claims: Local source (deployed from $(pwd))"
    echo "  SSL Email: ${SSL_EMAIL}"
    echo ""
    echo "Access URLs:"
    echo "  HTTP: http://${DOMAIN}"
    echo "  HTTPS: https://${DOMAIN} (after SSL setup completes)"
    echo "  API Health: http://${DOMAIN}/api/health"
    echo ""
    echo "Google OAuth2 Redirect URI (add to GCP Console):"
    echo "  https://${DOMAIN}/api/auth/google/callback"
    echo ""
    echo "SSH into VM:"
    echo "  gcloud compute ssh ${VM_NAME} --zone=${ZONE}"
    echo ""
    echo "Check service status:"
    echo "  sudo systemctl status ytdt-claims-pipeline"
    echo "  sudo systemctl status yt-validator"
    echo ""
    echo "View logs:"
    echo "  sudo cat /var/log/cloud-init-output.log"
    echo "  sudo journalctl -u ytdt-claims-pipeline -f"
    echo "  sudo journalctl -u yt-validator -f"
    echo ""
    echo "SSL certificate auto-renews via cron (daily check at 3 AM)"
    echo "============================================================================"
}

# ============================================================================
# Main
# ============================================================================

main() {
    log "Starting deployment..."
    
    check_prerequisites
    upload_source_code
    create_vm
    get_vm_info
    wait_for_services
    display_summary
}

# Run main function
main