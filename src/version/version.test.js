import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, it, expect } from 'vitest'

describe('version', () => {
  it('should export VERSION constant', async () => {
    const { VERSION } = await import('../version/index.js')
    expect(VERSION).toBeDefined()
    expect(typeof VERSION).toBe('string')
  })

  it('should match package.json version', async () => {
    const { VERSION } = await import('../version/index.js')
    const packageJsonPath = join(process.cwd(), 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    expect(VERSION).toBe(packageJson.version)
  })
})
