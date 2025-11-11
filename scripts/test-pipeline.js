#!/usr/bin/env node

/*
# Test with or without VPN (for local MySQL)
sudo node test-pipeline.js [--skip-vpn]
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
    mcnVerdicts: mcnVerdictsPath,
  };
}

// Test individual steps
async function testSteps() {
  console.log('\n=== Testing Individual Steps ===\n');

  // Test 1: Check environment variables
  console.log('1. Checking environment variables...');
  const requiredEnvs = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
  const missingEnvs = requiredEnvs.filter((env) => !process.env[env]);

  if (missingEnvs.length > 0) {
    console.error('❌ Missing environment variables:', missingEnvs);
    console.log('   Please check your .env file');
    return false;
  }
  console.log('✓ All required environment variables present');

  // Test 2: Check VPN config file
  console.log('\n2. Checking VPN config...');
  const vpnConfigPath = process.env.VPN_CONFIG_FILE || './config/vpn/client.ovpn';
  try {
    await fs.access(vpnConfigPath);
    console.log('✓ VPN config file found');
  } catch {
    console.error('❌ VPN config not found at:', vpnConfigPath);
    console.log('   You can skip VPN for testing by commenting out the connect_vpn step');
  }

  // Test 3: Test MySQL connection (without VPN for local testing)
  console.log('\n3. Testing MySQL connection...');
  if (process.env.MYSQL_HOST === 'localhost' || process.env.SKIP_VPN === 'true') {
    const mysql = require('mysql2/promise');
    try {
      const connection = await mysql.createConnection({
        host: process.env.MYSQL_HOST,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
      });

      const [rows] = await connection.execute('SELECT 1 as test');
      console.log('✓ MySQL connection successful:', rows[0]);
      await connection.end();
    } catch (error) {
      console.error('❌ MySQL connection failed:', error.message);
      console.log('   Check your MySQL credentials');
    }
  } else {
    console.log('⚠ Skipping MySQL test (requires VPN for remote host)');
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
      jfmVerdicts: null,
    };

    console.log('\nStarting pipeline with test files...\n');

    // Run pipeline
    const result = await runPipeline(files, {
      skipVPN: process.env.SKIP_VPN === 'true',
      testMode: true,
    });

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

  // Check if we should skip VPN
  if (process.argv.includes('--skip-vpn')) {
    process.env.SKIP_VPN = 'true';
    console.log('ℹ Skipping VPN connection for testing\n');
  }

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

  await new Promise((resolve) => {
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
