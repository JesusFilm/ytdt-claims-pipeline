import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))

const versionFile = `// This file is auto-generated from package.json
// Run: node scripts/sync-version.js
export const VERSION = '${packageJson.version}';
`

writeFileSync(join(__dirname, '../src/version.js'), versionFile, 'utf8')
console.log(`✓ Synced version to ${packageJson.version}`)
