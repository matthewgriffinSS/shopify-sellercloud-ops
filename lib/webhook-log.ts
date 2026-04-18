import { sql } from './db'

export async function logWebhook(params: {
  topic: string
  shopifyId?: string | number | null
  signatureOk: boolean
  processed?: boolean
  error?: string | null
}) {
  const { topic, shopifyId, signatureOk, processed = false, error = null } = params
  await sql`
    INSERT INTO webhook_log (topic, shopify_id, signature_ok, processed, error)
    VALUES (${topic}, ${shopifyId ? String(shopifyId) : null}, ${signatureOk}, ${processed}, ${error})
  `
}
