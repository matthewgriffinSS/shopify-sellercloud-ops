import { fetchLateFulfillments, statusMapForResources } from '@/lib/queries'
import { ActionDropdown } from './ActionForm'
import { TagPill, daysAgo, formatMoney } from './shared'

export async function LateFulfillments() {
  const rows = await fetchLateFulfillments()
  const statusMap = await statusMapForResources(
    'order',
    rows.map((r) => r.id),
  )

  return (
    <div className="card">
      <h3>Late fulfillments</h3>
      {rows.length === 0 ? (
        <div className="empty">No late fulfillments. Nice.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '10%' }}>Order</th>
              <th style={{ width: '18%' }}>Customer</th>
              <th style={{ width: '8%' }}>Late</th>
              <th style={{ width: '10%' }}>Value</th>
              <th style={{ width: '18%' }}>Support rep</th>
              <th style={{ width: '18%' }}>Status</th>
              <th style={{ width: '18%' }} className="r">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const days = daysAgo(new Date(r.shopify_created_at))
              const lateBadge = days >= 7 ? 'b-d' : 'b-w'
              const status = statusMap.get(r.id)
              const processed = status?.status === 'processed'
              return (
                <tr key={r.id} className={processed ? 'done' : ''}>
                  <td>#{r.order_number}</td>
                  <td>{r.customer_name ?? '—'}</td>
                  <td>
                    <span className={`bdg ${lateBadge}`}>{days}d</span>
                  </td>
                  <td>{formatMoney(r.total_price)}</td>
                  <td>
                    <TagPill rep={r.assigned_rep} service={r.service_type} tags={r.tags} />
                  </td>
                  <td>
                    {processed ? (
                      <span className="bdg b-s">
                        Processed {status?.actionType.replace(/_/g, ' ')}
                      </span>
                    ) : status?.status === 'in_progress' ? (
                      <span className="bdg b-w">In progress</span>
                    ) : (
                      <span className="bdg b-d">Needs action</span>
                    )}
                  </td>
                  <td className="r">
                    <ActionDropdown
                      resourceType="order"
                      resourceId={r.id}
                      resourceLabel={`#${r.order_number} — ${r.customer_name ?? 'customer'} · ${formatMoney(r.total_price)}`}
                      actions={[
                        { value: 'mark_fulfilled', label: 'Mark fulfilled + tracking' },
                        { value: 'add_note', label: 'Add note to SC' },
                        { value: 'escalate', label: 'Escalate to warehouse' },
                        { value: 'release_hold', label: 'Release hold' },
                        { value: 'mark_processed', label: 'Mark processed' },
                      ]}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
