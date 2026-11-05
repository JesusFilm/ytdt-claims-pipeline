#!/usr/bin/env node

/*
# Needs the BigQuery service account key named by BQ_KEY_FILE
node test-pipeline.js
*/

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { runPipeline } = require('../src/pipeline');

// Create test CSV files
async function createTestFiles() {
  const testDir = path.join(__dirname, '..', 'data', 'test');
  await fs.mkdir(testDir, { recursive: true });

  // Create a minimal claims CSV
  const claimsCSV = `claim_id,video_id,channel_id,asset_labels,claim_origin,views,video_title,channel_display_name
TEST001,abc123,UCtest123,"Jesus Film Project",WEB_UPLOAD,1000,"Test Video","Test Channel"
TEST002,def456,UCtest456,"Jesus Film",MANUAL_CLAIM,500,"Another Video","Another Channel"`;

  const claimsPath = path.join(testDir, 'test_claims.csv');
  await fs.writeFile(claimsPath, claimsCSV);
  console.log('✓ Created test claims file');

  // Create a minimal verdicts CSV
  const verdictsCSV = `video_id,verdict,media_component_id,language_id,wave,no_code
abc123,Y,MC001,529,1,
def456,N,MC002,1818,2,`;

  const mcnVerdictsPath = path.join(testDir, 'test_mcn_verdicts.csv');
  await fs.writeFile(mcnVerdictsPath, verdictsCSV);
  console.log('✓ Created test verdicts file');

  return {
    claims: claimsPath,
    mcnVerdicts: mcnVerdictsPath
  };
}

// Test individual steps
async function testSteps() {
  console.log('\n=== Testing Individual Steps ===\n');

  // Test 1: Check environment variables
  console.log('1. Checking environment variables...');
  // BQ_DATASET and BQ_KEY_FILE both have defaults; only the project must be set.
  const requiredEnvs = ['BQ_PROJECT_ID'];
  const missingEnvs = requiredEnvs.filter(env => !process.env[env]);
  
  if (missingEnvs.length > 0) {
    console.error('❌ Missing environment variables:', missingEnvs);
    console.log('   Please check your .env file');
    return false;
  }
  console.log('✓ All required environment variables present');

  // Test 2: Check the service account key
  console.log('\n2. Checking BigQuery key file...');
  const keyFile = process.env.BQ_KEY_FILE || './config/service-account-key.json';
  try {
    await fs.access(keyFile);
    console.log('✓ Service account key found');
  } catch (error) {
    console.error('❌ Service account key not found at:', keyFile);
    return false;
  }

  // Test 3: Test the BigQuery connection
  console.log('\n3. Testing BigQuery connection...');
  try {
    const { getBigQueryClient, tableRef } = require('../src/lib/bigquery');
    const [rows] = await getBigQueryClient().query({
      query: `SELECT COUNT(*) AS claims FROM ${tableRef('youtube_mcn_claims')}`
    });
    console.log('✓ BigQuery connection successful:', rows[0]);
  } catch (error) {
    console.error('❌ BigQuery connection failed:', error.message);
    console.log('   Check BQ_PROJECT_ID, BQ_DATASET and the service account\'s access');
  }

  return true;
}

// Run full pipeline test
async function testFullPipeline() {
  console.log('\n=== Testing Full Pipeline ===\n');
  
  try {
    // Create test files
    const testFiles = await createTestFiles();
    
    // Prepare test context
    const files = {
      claims: testFiles.claims,
      claimsSource: 'test_source',
      mcnVerdicts: testFiles.mcnVerdicts,
      jfmVerdicts: null
    };

    console.log('\nStarting pipeline with test files...\n');
    
    // Run pipeline
    const result = await runPipeline(files, {
      testMode: true
    }, null, { source: 'test', user: 'test-script' });

    console.log('\n✅ Pipeline completed successfully!');
    console.log('Result:', JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('\n❌ Pipeline failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Main test runner
async function main() {
  console.log('YouTube MCN Pipeline Test\n');
  console.log('========================\n');

  // Run tests
  const stepsOk = await testSteps();
  
  if (!stepsOk) {
    console.log('\n⚠ Fix the issues above before running the full pipeline');
    process.exit(1);
  }

  // Ask user if they want to run full pipeline
  console.log('\n-----------------------------------');
  console.log('Ready to test full pipeline?');
  console.log('This will create test data in your database.');
  console.log('Press Ctrl+C to cancel, or Enter to continue...');
  
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  await testFullPipeline();
  
  console.log('\nTest complete!');
  process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

// Run tests
if (require.main === module) {
  main();
}