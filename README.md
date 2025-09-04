# ytdt-claims-pipeline

Node.js API server.

## Requisites

1. OpenVPN - Setup, start and test

Drop `ca.crt`, `client.crt`, `client.key`, `client.ovpn` into `./config/vpn`, then

```shell
brew install openvpn    # Optional
sudo openvpn --config ./config/vpn/client.ovpn
```

## Dev

### Run

```shell
yarn dev
```

### Test

```shell
SKIP_VPN=true sudo node scripts/test-pipeline.js
```

Expected response:
```
YouTube MCN Pipeline Test

========================


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