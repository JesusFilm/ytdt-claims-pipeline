import { createReadStream } from 'fs'
import readline from 'readline'

import { format } from 'date-fns'

import { env } from '../env.js'

export function cleanRow(row) {
  const cleaned = {}
  Object.entries(row).forEach(([key, value]) => {
    if (typeof value === 'string') {
      value = value.trim()
      value = value.replace(/\r/g, '')
      value = value.replace(/^'|'$/g, '') // Remove Excel quotes
    }
    cleaned[key] = value
  })
  return cleaned
}

export function formatDuration(ms) {
  if (!ms) return `♾️`
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export function generateRunFolderName(startTime) {
  return format(startTime, env.EXPORT_FOLDER_NAME_FORMAT)
}

export async function readFile(filePath, n = 2) {
  const rl = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  })

  const lines = []
  for await (const line of rl) {
    lines.push(line)
    if (lines.length === n) break
  }
  rl.close()
  return lines.join('\n')
}
