#!/usr/bin/env node
/**
 * Test script for YouTube MCN Claims Pipeline
 * This script performs basic tests on the pipeline steps and runs a full end-to-end test with sample data.
 * It checks for required environment variables, BigQuery connectivity, and validates the processing of claims and verdicts.
 * 
 * Usage: 
 *   1. Ensure exists .env file with the necessary configuration (copy from .env.example).
 *   2. Run script: `node scripts/test-pipeline.js`.
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { runPipeline } = require('../src/pipeline');
const { connectToDatabase } = require('../src/database');


const TEST_DIR = path.join(__dirname, '..', 'data', 'test');

// Test individual steps
async function testSteps() {
  console.log('\n=== Testing Individual Steps ===\n');

  // Test 1: Check environment variables
  console.log('1. Checking environment variables...');
  const requiredEnvs = ['BQ_PROJECT_ID', 'BQ_DATASET'];
  const missingEnvs = requiredEnvs.filter(env => !process.env[env]);

  if (missingEnvs.length > 0) {
    console.error('❌ Missing environment variables:', missingEnvs);
    console.log('   Please check your .env file');
    return false;
  }
  console.log('✓ All required environment variables present');

  // Test 2: Check BigQuery connection
  console.log('\n2. Testing BigQuery connection...');
  try {
    const { getBigQueryClient, BQ_DATASET } = require('../src/lib/bigquery');
    const bq = getBigQueryClient();
    const [datasets] = await bq.getDatasets();
    const found = datasets.some(d => d.id === BQ_DATASET);
    if (found) {
      console.log(`✓ BigQuery dataset '${BQ_DATASET}' found`);
    } else {
      console.error(`❌ BigQuery dataset '${BQ_DATASET}' not found`);
      return false;
    }
  } catch (error) {
    console.error('❌ BigQuery connection failed:', error.message);
    console.log('   Check service account key and BQ_PROJECT_ID env');
    return false;
  }

  // Test 3: Check service account key
  console.log('\n3. Checking service account key...');
  const keyPath = process.env.BQ_KEY_FILE || './config/service-account-key.json';
  try {
    await fs.access(keyPath);
    console.log('✓ Service account key found');
  } catch (error) {
    console.error('❌ Service account key not found at:', keyPath);
    return false;
  }

  // Test 4: Check test data files exist
  console.log('\n4. Checking test data files...');
  const testFiles = [
    'test_claims_matter_entertainment.csv',
    'test_claims_matter_2.csv',
    'test_mcn_verdicts.csv',
    'test_jfm_verdicts.csv'
  ];
  for (const file of testFiles) {
    try {
      await fs.access(path.join(TEST_DIR, file));
      console.log(`✓ ${file}`);
    } catch (error) {
      console.error(`❌ ${file} not found in ${TEST_DIR}`);
      return false;
    }
  }

  return true;
}

// Run full pipeline test
async function testFullPipeline() {
  console.log('\n=== Testing Full Pipeline ===\n');

  try {

    // Prepare test context
    const files = {
      claims: {
        matter_entertainment: path.join(TEST_DIR, 'test_claims_matter_entertainment.csv'),
        matter_2: path.join(TEST_DIR, 'test_claims_matter_2.csv')
      },
      mcnVerdicts: path.join(TEST_DIR, 'test_mcn_verdicts.csv'),
      jfmVerdicts: path.join(TEST_DIR, 'test_jfm_verdicts.csv')
    };

    // Run pipeline
    console.log('\nStarting pipeline with test files...\n');
    await connectToDatabase();
    const result = await runPipeline(files, { testMode: true });

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

  const stepsOk = await testSteps();

  if (!stepsOk) {
    console.log('\n⚠ Fix the issues above before running the full pipeline');
    process.exit(1);
  }

  console.log('\n-----------------------------------');
  console.log('Ready to test full pipeline?');
  console.log('This will create test data in BigQuery.');
  console.log('Press Enter to continue, or Ctrl+C to cancel...\n');

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