import { fetchVipOrders, statusMapForResources } from '@/lib/queries'
import { ActionDropdown } from './ActionForm'
import { formatMoney } from './shared'

export async function VipOrders() {
  const rows = await fetchVipOrders()
  const statusMap = await statusMapForResources(
    'order',
    rows.map((r) => r.id),
  )
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN ?? null
  const scAdminUrl = process.env.SELLERCLOUD_ADMIN_URL ?? null

  return (
    <div className="card">
      <h3>VIP orders — this week</h3>
      {rows.length === 0 ? (
        <div className="empty">No VIP orders this week.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '11%' }}>Order</th>
              <th style={{ width: '10%' }}>SC</th>
              <th style={{ width: '26%' }}>Customer</th>
              <th style={{ width: '13%' }}>Value</th>
              <th style={{ width: '18%' }}>Status</th>
              <th style={{ width: '22%' }} className="r">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const status = statusMap.get(r.id)
              // Query already excludes terminal-action orders; this only
              // catches out-of-sync display states where Shopify marked
              // an order fulfilled but we haven't logged a matching action.
              const processed =
                status?.status === 'processed' || r.fulfillment_status === 'fulfilled'
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
                  <td>
                    {r.customer_name ?? '—'} <span className="bdg b-i">VIP</span>
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
