import { type ChildProcess } from 'child_process'

import { type Pool } from 'mysql2/promise'

export interface PipelineContext {
  files: {
    claims?: {
      matter_entertainment?: string
      matter_2?: string
    }
    mcnVerdicts?: string
    jfmVerdicts?: string
  }
  options: Record<string, unknown>
  connections: {
    mysql?: Pool
    vpnProcess?: ChildProcess
  }
  outputs: Record<string, unknown>
  status: string
  startTime: Date | number
  runId?: string
}
