// Run schema.sql against DATABASE_URL. Usage: `npm run db:init`
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set. Source .env first.')
  }
  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 })
  const schema = readFileSync(join(process.cwd(), 'db', 'schema.sql'), 'utf8')
  await sql.unsafe(schema)
  console.log('Schema applied.')
  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
