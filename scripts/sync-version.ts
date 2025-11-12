import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))

const versionFile = `// This file is auto-generated from package.json
// Run: tsx scripts/sync-version.ts
export const VERSION = '${packageJson.version}'
`

writeFileSync(join(__dirname, '../src/version/version.ts'), versionFile, 'utf8')
console.log(`✓ Synced version to ${packageJson.version}`)
