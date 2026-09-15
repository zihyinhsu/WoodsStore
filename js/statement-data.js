import { sb } from './supabase.js';

// 對帳單左欄彙總：期間內有出貨或收款的客戶及其餘額。
// 明細不在這裡撈——右欄改為切到該客戶時才按需載入（見 fetchStatementLines），
// 避免區間拉大時把全部客戶的出貨明細一次灌進瀏覽器。
export async function fetchStatementSummary(from, to) {
  const { data, error } = await sb.rpc('statement_summary', { p_from: from, p_to: to });
  if (error) throw error;

  return (data || []).map(row => ({
    partner: {
      id: row.id,
      partner_no: row.partner_no,
      name: row.name,
      tax_id: row.tax_id,
      phone: row.phone,
      address: row.address
    },
    // RPC 的 numeric 會以字串回傳，轉成數值供 round2／formatCurrency 與正負判斷使用。
    prevBalance: Number(row.prev_balance),
    prevPaid: Number(row.prev_paid),
    currentSales: Number(row.current_sales),
    currentPaid: Number(row.current_paid),
    totalBalance: Number(row.total_balance)
  }));
}

// 單一客戶在期間內的出貨明細。切到該客戶的分頁時才載入。
// 直接查 view 即可：明細是一列一筆、不需聚合。排序與原本全撈時一致（日期、單號）。
export async function fetchStatementLines(partnerId, from, to) {
  const { data, error } = await sb
    .from('statement_line_view')
    .select('*')
    .eq('partner_id', partnerId)
    .gte('order_date', from)
    .lte('order_date', to)
    .order('order_date', { ascending: true })
    .order('order_no', { ascending: true });
  if (error) throw error;
  return data || [];
}
