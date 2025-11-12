import type { PipelineContext } from '../../types/pipeline'

export default async function backupTables(context: PipelineContext) {
  const mysql = context.connections.mysql
  if (!mysql) throw new Error('MySQL connection not available')

  const date = new Date().toISOString().split('T')[0].replace(/-/g, '_')

  await mysql.query(`
    CREATE TABLE IF NOT EXISTS youtube_mcn_claims_bkup_${date}
    AS SELECT * FROM youtube_mcn_claims
  `)

  console.log(`Backup created: youtube_mcn_claims_bkup_${date}`)
}
