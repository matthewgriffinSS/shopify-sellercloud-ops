import postgres from 'postgres'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

// Reuse connection across lambda invocations in dev.
// In production Vercel serverless, each invocation gets its own connection;
// postgres.js handles pooling gracefully.
declare global {
  // eslint-disable-next-line no-var
  var __sqlClient: ReturnType<typeof postgres> | undefined
}

export const sql =
  global.__sqlClient ??
  postgres(process.env.DATABASE_URL, {
    max: 5,
    ssl: 'require',
    idle_timeout: 20,
    connect_timeout: 10,
  })

if (process.env.NODE_ENV !== 'production') {
  global.__sqlClient = sql
}
