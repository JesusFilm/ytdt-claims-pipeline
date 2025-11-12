import { readFileSync } from 'fs'
import { join } from 'path'

describe('version', () => {
  it('should export VERSION constant', async () => {
    const { VERSION } = await import('../version')
    expect(VERSION).toBeDefined()
    expect(typeof VERSION).toBe('string')
  })

  it('should match package.json version', async () => {
    const { VERSION } = await import('../version')
    const packageJsonPath = join(process.cwd(), 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    expect(VERSION).toBe(packageJson.version)
  })
})
