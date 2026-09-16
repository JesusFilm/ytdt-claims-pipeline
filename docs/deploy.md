# Deployment Configuration

## Overview

This deployment uses **local source code** and **local configuration** - no GitHub, no Secret Manager. 

The deploy script (`infrastructure/gcp/deploy.sh`):

1. Loads all environment variables from `.env.production` (including secrets)
2. Creates source code tarball and uploads to GCS
3. Replaces all placeholders in `cloud-config.yaml` with actual values from `./.env.production`
4. Deploys Ubuntu VM with the populated cloud-config

The VM provisioning (`cloud-config.yaml`):

1. Installs dependencies: Node.js v20, Nginx, OpenVPN, Miniconda, git-lfs
2. Downloads and extracts ytdt-claims-pipeline source from GCS
3. Runs `npm install`
4. Clones YT-Validator repo and creates conda environment
5. Fetches the ML model artifact (~1.4 GB) from GCS — it is not in git, since
   GitHub caps files at 100 MB. Falls back to Git LFS if `model-bucket` is
   unset. See [YT-Validator's deploy runbook](https://github.com/matthew-jf/YT-Validator/blob/ML-Pipeline/docs/deploy.md).
6. Gets external IP and creates domain (`<IP>.nip.io`)
7. Creates `/etc/ytdt-claims-pipeline/.env` with all pre-populated variables from deploy script
8. Appends dynamic variables to `/etc/ytdt-claims-pipeline/.env`:
   - BASE_URL (http/https based on SSL status)
   - ML_API_ENDPOINT (http://localhost:3001)
   - GOOGLE_REDIRECT_URI (includes protocol based on SSL)
9. Configures Nginx as reverse proxy with SSL via Let's Encrypt
10. Sets up SSL auto-renewal cron job
11. Creates systemd services:
    - **yt-validator**: Creates `/opt/yt-validator/.env` with BASE_URL and YT_API_KEY
    - **ytdt-claims-pipeline**: Sources `/etc/ytdt-claims-pipeline/.env` before starting
12. Starts both services

All secrets and configuration come from `.env.production`.

## Prerequisites

- `gcloud` CLI installed and authenticated
- `.env.production` file with **all** required environment variables including secrets 
  from both `ytdy-claims-pipeline` (see `src/.env.example`) and `YT-Validator`.
- `config/` directory with:
  - `config/vpn/client.ovpn` (VPN configuration)
  - `config/service-account-key.json` (Google service account for Drive access)

## Developing the console against a deployed API

After Google login the API redirects to `FRONTEND_URL`, which is server-side —
so by default every client, including `localhost` and Vercel previews, lands on
the production console.

To let another origin be returned to itself, add it to
`FRONTEND_URL_ALLOWLIST` (comma-separated) in `/etc/ytdt-claims-pipeline/.env`:

```
FRONTEND_URL_ALLOWLIST=http://localhost:3002
```

`FRONTEND_URL` is always allowed and does not need listing. Anything not on the
list falls back to it, so leaving this unset keeps today's behaviour.

The console sends its own origin as `redirect_uri` when starting login; the API
validates it and carries it through Google in the OAuth `state` parameter. The
allowlist is a security boundary, not a convenience: the API appends a session
token to that URL, so an unlisted origin must never be honoured.

## Deploy

```bash
# Env variables - Cf. `infrastructure/gcp/deploy.sh`.
# 1. **deploy.sh** reads environment variables (or uses defaults)
# 2. Passes them as VM metadata during instance creation
# 3. **cloud-config.yaml** reads from GCP metadata service
# 4. Uses the values during setup
export SSL_EMAIL="edouard.carvalho@p2c.com"
export LETSENCRYPT_STAGING="--staging"

# ML model artifact. Unset falls back to Git LFS, which is slower and needs
# git-lfs on the VM. Publish a version first with YT-Validator's upload_model.sh.
export MODEL_BUCKET="gs://jfp-yt-validator-models"
export MODEL_VERSION="v1"
export MODEL_NAME="ag_challenger_deploy"

# Branch must carry the ML pipeline; chore/cli-api-wrapper has no model.
export YT_VALIDATOR_BRANCH="ML-Pipeline"

# From project root
./infrastructure/gcp/deploy.sh
```

> `cloud-config.yaml` is VM user-data: it runs **only on first boot**. Running
> `deploy.sh` against an existing VM re-uploads the Node source but does not
> re-provision — it logs `VM already exists. Skipping creation.` To update
> YT-Validator on a running VM, follow
> [its runbook](https://github.com/matthew-jf/YT-Validator/blob/ML-Pipeline/docs/deploy.md#update-the-service-on-a-running-vm)
> instead.

## Branches and mirroring

`main` is the trunk and feature branches PR into it; `dev` was retired on 2026-09-16.
Keep `legacy/typescript-rewrite-2025` (archive of the old `main`, the stalled TypeScript/ESM
rewrite) and `feat/export-views-bigquery` (the MySQL → BigQuery migration).

The VM tracks `main`. To ship merged work without re-provisioning:

```shell
gcloud compute ssh ytdt-claims --zone=us-east1-b
cd /opt/ytdt-claims-pipeline
git fetch origin && git checkout main && git pull --ff-only origin main
sudo systemctl restart ytdt-claims-pipeline
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health   # expect 200
```

`ceduth/ytdt-claims-pipeline` is a mirror of this repo, updated by hand today:

```shell
git push fork "+refs/remotes/origin/main:refs/heads/main"
```

`.github/workflows/mirror.yml` automates that on push to `main` but is **disabled** until
`MIRROR_SSH_KEY` is a deploy key with write access on the mirror. It pushes an explicit refspec
rather than `--mirror` (a CI checkout has remote-tracking refs, not local branches, so `--mirror`
would publish `refs/remotes/*` and delete the mirror's real branches) and refuses any remote URL
naming this repo: `ceduth-jfp/ytdt-claims-pipeline` is a permanent redirect back to
`JesusFilm/ytdt-claims-pipeline`, so a mirror aimed there force-pushes this repo onto itself.

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

The VM metadata is set at creation time, and `cloud-config.yaml` only runs on
first boot. To change provisioning:
1. Delete the VM: `gcloud compute instances delete ytdt-claims --zone=us-east1-b`
2. Set new environment variables
3. Redeploy: `./infrastructure/gcp/deploy.sh`

Most day-to-day changes do **not** need this. To update application code on a
running VM, pull the repo and restart the relevant service — for YT-Validator,
follow [its runbook](https://github.com/matthew-jf/YT-Validator/blob/ML-Pipeline/docs/deploy.md#update-the-service-on-a-running-vm).
To ship a new model, publish a version to GCS and refetch; no redeploy needed.

### SSL Certificate Fails

- Check logs: `sudo cat /var/log/letsencrypt/letsencrypt.log`
- Deploy certificate manually, eg. 
```shell
sudo rm -rf /etc/letsencrypt/accounts
sudo certbot --nginx -d 35.227.61.101.nip.io --non-interactive --agree-tos --email edouard.carvalho@p2c.com --redirect
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

3. Check whether provisioning completed
```bash
sudo journalctl -u cloud-final -n 100
```

4. Check service status
```bash
sudo systemctl status ytdt-claims-pipeline
sudo systemctl status yt-validator
```

5. If services still fail, check their logs
```bash
sudo journalctl -u ytdt-claims-pipeline -n 50
sudo journalctl -u yt-validator -n 50
```

> `yt-validator` reporting `active` does not mean it is serving. It loads a
> ~1.4 GB model before binding its port (~30s cold), and `Restart=always` makes
> a crash loop look like a running service. Check
> `systemctl show yt-validator -p NRestarts --value` — a climbing counter means
> it is failing at startup. `curl localhost:3001/health` returns 503 until the
> model is loaded and warm. See
> [YT-Validator troubleshooting](https://github.com/matthew-jf/YT-Validator/blob/ML-Pipeline/docs/deploy.md#troubleshooting).

### vm-routing service (asymmetric routing during VPN)

The `vm-routing` service is normally already deployed via [cloud-config](infrastructure/gcp/cloud-config.yaml).
The `vm-routing` service adds a policy route so inbound traffic to the VM's external IP replies via the local gateway, not the VPN tunnel. Without it, the console at https://ytdt-claims-console.jesusfilm.org can't reach the backend while the pipeline VPN is up.

Verify it's installed and active:
```bash
sudo systemctl status vm-routing
ip rule | grep 128
ip route show table 128
```

Expected:
- `from <VM_INTERNAL_IP> lookup 128`
- `default via <GATEWAY> dev ens4`

If missing, install manually:
```bash
sudo tee /etc/systemd/system/vm-routing.service > /dev/null <<'EOF'
[Unit]
Description=VM symmetric routing (bypass VPN for inbound traffic)
After=network-online.target
Wants=network-online.target
Before=ytdt-claims-pipeline.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'IFACE=$(ip route show default | awk "{print \$5; exit}"); IP=$(ip -4 -o addr show $IFACE | awk "{print \$4}" | cut -d/ -f1); GW=$(ip route show default dev $IFACE | awk "{print \$3}"); ip rule add from $IP table 128 2>/dev/null || true; ip route add table 128 default via $GW dev $IFACE 2>/dev/null || true'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now vm-routing
```

Test while pipeline VPN is up:
```bash
# from external host (not the VM)
curl -I https://<EXTERNAL_IP>.nip.io
```
Should return a response from nginx, not hang.
