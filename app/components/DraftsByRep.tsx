import { fetchDraftsByRep } from '@/lib/queries'
import { formatMoney } from './shared'

export async function DraftsByRep() {
  const rows = await fetchDraftsByRep()

  return (
    <div className="card">
      <h3>Draft order follow-ups by rep</h3>
      {rows.length === 0 ? (
        <div className="empty">No open drafts.</div>
      ) : (
        <div className="rep-grid">
          {rows.map((r) => {
            const stale = parseInt(r.stale_count)
            return (
              <div key={r.assigned_rep} className="rep-c">
                <p className="rep-n">{r.assigned_rep}</p>
                <p className="rep-ct">{r.count}</p>
                <p className="rep-v">
                  {formatMoney(r.total_value)}
                  {stale > 0 && ` · ${stale} stale`}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
