import { createReadStream } from 'fs'
import readline from 'readline'

import { format } from 'date-fns'

import { env } from '../../env'

export function cleanRow(row: Record<string, unknown>) {
  const cleaned: Record<string, unknown> = {}
  Object.entries(row).forEach(([key, value]) => {
    if (typeof value === 'string') {
      let cleanedValue = value
      cleanedValue = cleanedValue.trim()
      cleanedValue = cleanedValue.replace(/\r/g, '')
      cleanedValue = cleanedValue.replace(/^'|'$/g, '') // Remove Excel quotes
      cleaned[key] = cleanedValue
    } else {
      cleaned[key] = value
    }
  })
  return cleaned
}

export function formatDuration(ms: number | null | undefined) {
  if (!ms) return `♾️`
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export function generateRunFolderName(startTime: Date) {
  return format(startTime, env.EXPORT_FOLDER_NAME_FORMAT)
}

export async function readFile(filePath: string, n = 2) {
  const rl = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  })

  const lines: string[] = []
  for await (const line of rl) {
    lines.push(line)
    if (lines.length === n) break
  }
  rl.close()
  return lines.join('\n')
}
