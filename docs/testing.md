## Testing (sample data)

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

Runs pre-flight checks (env vars, BigQuery connectivity, service account key, test file existence), then executes the full pipeline with sample data from `data/test/`. Both claim sources (matter_entertainment, matter_2) and both verdict types (MCN, JFM) are exercised. Requires interactive confirmation before running.

Test files:
- `data/test/test_claims_matter_entertainment.csv` — 2 sample Matter Entertainment claims
- `data/test/test_claims_matter_2.csv` — 2 sample Matter 2 claims
- `data/test/test_mcn_verdicts.csv` — MCN verdicts for matter_entertainment video IDs
- `data/test/test_jfm_verdicts.csv` — JFM verdicts for matter_2 video IDs

### Test data cleanup

Test runs create temporary tables and insert test rows into BigQuery. To clean up after testing:
```sql
-- Remove test rows from main table
DELETE FROM <BQ_DATASET>.youtube_mcn_claims WHERE video_id LIKE 'vid_me%' OR video_id LIKE '-vid_me%' OR video_id LIKE 'vid_m2%';

-- Drop temp tables (replace date as needed)
DROP TABLE IF EXISTS <BQ_DATASET>.claim_report_YYYYMMDD_matter_entertainment;
DROP TABLE IF EXISTS <BQ_DATASET>.claim_report_YYYYMMDD_matter_2;
DROP TABLE IF EXISTS <BQ_DATASET>.mcn_verdicts_YYYYMMDD;
DROP TABLE IF EXISTS <BQ_DATASET>.jfm_verdicts_YYYYMMDD;

-- Drop backup table
DROP TABLE IF EXISTS <BQ_DATASET>.youtube_mcn_claims_bkup_YYYY_MM_DD;
```