import { fetchAbandonedCarts } from '@/lib/queries'
import { ActionDropdown } from './ActionForm'
import { formatMoney, timeAgo } from './shared'

export async function AbandonedCarts() {
  const rows = await fetchAbandonedCarts()

  return (
    <div className="card">
      <h3>High-value abandoned carts ($2000+)</h3>
      {rows.length === 0 ? (
        <div className="empty">No high-value abandoned carts in the last 7 days.</div>
      ) : (
        <div className="cart-grid">
          {rows.map((r) => (
            <div key={r.id} className="cart-c">
              <p className="cart-cu">{r.customer_email ?? r.customer_name ?? 'Anonymous cart'}</p>
              <p className="cart-m">
                Abandoned {timeAgo(new Date(r.abandoned_at))} · {r.line_item_count} items
              </p>
              <p className="cart-v">{formatMoney(r.total_price)}</p>
              <p className="cart-rep">
                {r.assigned_rep ? (
                  <>
                    Assigned: <span className="tag-p auto">{r.assigned_rep}</span>
                  </>
                ) : r.contacted_at ? (
                  `Contacted ${timeAgo(new Date(r.contacted_at))}`
                ) : (
                  'Unassigned'
                )}
              </p>
              <div className="cart-a">
                <ActionDropdown
                  resourceType="abandoned_checkout"
                  resourceId={r.id}
                  resourceLabel={`${r.customer_email ?? 'cart'} · ${formatMoney(r.total_price)}`}
                  actions={[
                    { value: 'recovery_email_sent', label: 'Mark recovery email sent' },
                    { value: 'contacted', label: 'Mark customer contacted' },
                    { value: 'add_note', label: 'Add note' },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
