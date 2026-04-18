import { fetchDraftsByRep } from '@/lib/queries'
import { formatMoney } from './shared'

export async function DraftsByRep() {
  const rows = await fetchDraftsByRep()

  return (
    <div className="sec">
      <div className="sec-h">
        <h3 className="sec-t">Draft order follow-ups by rep</h3>
      </div>
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
