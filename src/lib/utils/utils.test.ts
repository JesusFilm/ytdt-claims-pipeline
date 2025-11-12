import { writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { cleanRow, formatDuration, generateRunFolderName, readFile } from '../utils'

vi.mock('../../env', () => ({
  env: {
    EXPORT_FOLDER_NAME_FORMAT: 'yyyyMMddHHmmss',
  },
}))

describe('utils', () => {
  describe('cleanRow', () => {
    it('should trim string values', () => {
      const row = { name: '  test  ', value: 123 }
      const cleaned = cleanRow(row)
      expect(cleaned.name).toBe('test')
      expect(cleaned.value).toBe(123)
    })

    it('should remove carriage returns', () => {
      const row = { text: 'line1\rline2\r\nline3' }
      const cleaned = cleanRow(row)
      expect(cleaned.text).toBe('line1line2\nline3')
    })

    it('should remove Excel quotes', () => {
      const row = { text: "'quoted'" }
      const cleaned = cleanRow(row)
      expect(cleaned.text).toBe('quoted')
    })

    it('should handle empty strings', () => {
      const row = { empty: '' }
      const cleaned = cleanRow(row)
      expect(cleaned.empty).toBe('')
    })
  })

  describe('formatDuration', () => {
    it('should format milliseconds to seconds', () => {
      expect(formatDuration(5000)).toBe('5s')
      expect(formatDuration(1000)).toBe('1s')
    })

    it('should format milliseconds to minutes and seconds', () => {
      expect(formatDuration(65000)).toBe('1m 5s')
      expect(formatDuration(120000)).toBe('2m 0s')
    })

    it('should return infinity emoji for null/undefined', () => {
      expect(formatDuration(null)).toBe('♾️')
      expect(formatDuration(undefined)).toBe('♾️')
    })
  })

  describe('generateRunFolderName', () => {
    it('should generate folder name from date', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const folderName = generateRunFolderName(date)
      expect(folderName).toMatch(/^\d{14}$/)
    })
  })

  describe('readFile', () => {
    let testFile: string

    beforeEach(() => {
      const testDir = join(tmpdir(), 'test-utils')
      mkdirSync(testDir, { recursive: true })
      testFile = join(testDir, 'test.txt')
    })

    it('should read first n lines from file', async () => {
      writeFileSync(testFile, 'line1\nline2\nline3\nline4')
      const content = await readFile(testFile, 2)
      expect(content).toBe('line1\nline2')
    })

    it('should read entire file if n is larger than file', async () => {
      writeFileSync(testFile, 'line1\nline2')
      const content = await readFile(testFile, 10)
      expect(content).toBe('line1\nline2')
    })

    it('should handle empty file', async () => {
      writeFileSync(testFile, '')
      const content = await readFile(testFile, 2)
      expect(content).toBe('')
    })
  })
})
