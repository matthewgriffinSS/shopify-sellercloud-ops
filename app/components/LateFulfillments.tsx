import { fetchLateFulfillments, statusMapForResources } from '@/lib/queries'
import { ActionDropdown } from './ActionForm'
import { daysAgo, formatMoney } from './shared'

export async function LateFulfillments() {
  const rows = await fetchLateFulfillments()
  const statusMap = await statusMapForResources(
    'order',
    rows.map((r) => r.id),
  )
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN ?? null
  const scAdminUrl = process.env.SELLERCLOUD_ADMIN_URL ?? null

  return (
    <div className="card">
      <h3>Late fulfillments</h3>
      {rows.length === 0 ? (
        <div className="empty">No late fulfillments. Nice.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '11%' }}>Order</th>
              <th style={{ width: '10%' }}>SC</th>
              <th style={{ width: '22%' }}>Customer</th>
              <th style={{ width: '9%' }}>Late</th>
              <th style={{ width: '11%' }}>Value</th>
              <th style={{ width: '18%' }}>Status</th>
              <th style={{ width: '19%' }} className="r">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const days = daysAgo(new Date(r.shopify_created_at))
              const lateBadge = days >= 7 ? 'b-d' : 'b-w'
              const status = statusMap.get(r.id)
              // Note: rows with a terminal action are already excluded at the
              // query level, so `processed` here only catches the rare case
              // where status data is out of sync. Left in as defensive display.
              const processed = status?.status === 'processed'
              return (
                <tr key={r.id} className={processed ? 'done' : ''}>
                  <td>
                    {storeDomain ? (
                      <a
                        href={`https://${storeDomain}/admin/orders/${r.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="dfu-inv-link"
                      >
                        #{r.order_number}
                      </a>
                    ) : (
                      <>#{r.order_number}</>
                    )}
                  </td>
                  <td>
                    {r.sellercloud_order_id && scAdminUrl ? (
                      <a
                        href={`${scAdminUrl}/orders/order-details.aspx?id=${r.sellercloud_order_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="dfu-inv-link"
                      >
                        SC-{r.sellercloud_order_id}
                      </a>
                    ) : (
                      <span style={{ color: 'var(--text3)' }}>—</span>
                    )}
                  </td>
                  <td>{r.customer_name ?? '—'}</td>
                  <td>
                    <span className={`bdg ${lateBadge}`}>{days}d</span>
                  </td>
                  <td>{formatMoney(r.total_price)}</td>
                  <td>
                    {status?.status === 'in_progress' ? (
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
                        { value: 'add_note', label: 'Add note' },
                        { value: 'mark_processed', label: 'Mark handled' },
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
