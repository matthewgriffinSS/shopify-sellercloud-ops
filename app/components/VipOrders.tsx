import { fetchVipOrders, statusMapForResources } from '@/lib/queries'
import { ActionDropdown } from './ActionForm'
import { formatMoney } from './shared'

export async function VipOrders() {
  const rows = await fetchVipOrders()
  const statusMap = await statusMapForResources(
    'order',
    rows.map((r) => r.id),
  )

  return (
    <div className="card">
      <h3>VIP orders — this week</h3>
      {rows.length === 0 ? (
        <div className="empty">No VIP orders this week.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '12%' }}>Order</th>
              <th style={{ width: '32%' }}>Customer</th>
              <th style={{ width: '14%' }}>Value</th>
              <th style={{ width: '20%' }}>Status</th>
              <th style={{ width: '22%' }} className="r">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const status = statusMap.get(r.id)
              const processed =
                status?.status === 'processed' || r.fulfillment_status === 'fulfilled'
              return (
                <tr key={r.id} className={processed ? 'done' : ''}>
                  <td>#{r.order_number}</td>
                  <td>
                    {r.customer_name ?? '—'} <span className="bdg b-i">VIP</span>
                  </td>
                  <td>{formatMoney(r.total_price)}</td>
                  <td>
                    {processed ? (
                      <span className="bdg b-s">Processed</span>
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
                        { value: 'add_note', label: 'Add white-glove note' },
                        { value: 'escalate', label: 'Prioritize in warehouse' },
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
