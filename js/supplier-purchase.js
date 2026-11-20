// ============================================================
// 供應商進貨的資料存取層：包裝 patch-032 的 RPC，回傳整理過的結果。
// 頁面模組（dashboard.js / supplier-purchase-modal.js）不直接碰 sb.rpc，與 partner-profit.js 同分工。
//
// 口徑一律由 SQL 端決定（未稅、已扣分攤整單折讓、進貨退出為負數），與總覽「本月進貨成本」卡片相同；
// 這裡只做型別轉換：Postgres numeric 經 REST 回來是字串，直接拿去運算會變字串相接。
// ============================================================
import { sb } from './supabase.js';
import { PAGE_SIZE, toDateParam, toKeywordParam } from './utils.js';

export const SUPPLIER_PAGE_SIZE = PAGE_SIZE;

function toSupplierRow(row) {
  return {
    partnerId: row.partner_id,
    partnerNo: row.partner_no,
    name: row.name,
    purchaseAmount: Number(row.purchase_amount) || 0,
    // 進貨退出，負數
    returnAmount: Number(row.return_amount) || 0,
    netAmount: Number(row.net_amount) || 0,
    orderCount: Number(row.order_count) || 0,
    returnCount: Number(row.return_count) || 0,
    lastPurchaseDate: row.last_purchase_date
  };
}

export async function fetchSupplierPurchasePage({ from, to, keyword, page }) {
  const offset = (page - 1) * SUPPLIER_PAGE_SIZE;

  const { data, count, error } = await sb
    .rpc('supplier_purchase', {
      p_from: toDateParam(from),
      p_to: toDateParam(to),
      p_keyword: toKeywordParam(keyword)
    }, { count: 'exact' })
    // partner_no 是決勝鍵：淨額相同的供應商若沒有第二排序鍵，翻頁時會重複或漏列（同客戶毛利）。
    .order('net_amount', { ascending: false })
    .order('partner_no', { ascending: true })
    .range(offset, offset + SUPPLIER_PAGE_SIZE - 1);

  if (error) throw error;
  return { rows: (data || []).map(toSupplierRow), total: count || 0 };
}

export async function fetchSupplierPurchaseTotals(from, to, keyword) {
  const { data, error } = await sb.rpc('supplier_purchase_summary', {
    p_from: toDateParam(from),
    p_to: toDateParam(to),
    p_keyword: toKeywordParam(keyword)
  });

  if (error) throw error;

  const totals = data?.[0] || {};
  return {
    purchaseAmount: Number(totals.purchase_amount) || 0,
    returnAmount: Number(totals.return_amount) || 0,
    netAmount: Number(totals.net_amount) || 0,
    supplierCount: Number(totals.supplier_count) || 0
  };
}

// 單一供應商在指定區間的彙總（modal 上方的卡片）。
// 走 supplier_purchase 的 p_partner_id 而不是拿清單那一列的數字：modal 有自己的區間可以改，
// 沿用清單的數字會在改區間後與下方明細對不起來（同 fetchPartnerProfitDetail）。
// 該供應商在此區間沒有進貨時 RPC 不回任何列，此時回 null 由呈現層顯示空狀態。
export async function fetchSupplierPurchaseDetail(partnerId, from, to) {
  const { data, error } = await sb.rpc('supplier_purchase', {
    p_from: toDateParam(from),
    p_to: toDateParam(to),
    p_keyword: null,
    p_partner_id: partnerId
  });

  if (error) throw error;
  return data?.[0] ? toSupplierRow(data[0]) : null;
}

export async function fetchSupplierPurchaseItems({ partnerId, from, to, page }) {
  const offset = (page - 1) * SUPPLIER_PAGE_SIZE;

  const { data, count, error } = await sb
    .rpc('supplier_purchase_items', {
      p_partner_id: partnerId,
      p_from: toDateParam(from),
      p_to: toDateParam(to)
    }, { count: 'exact' })
    // 排序寫在這裡而非 SQL function 內：function 被 inline 之後內部的 ORDER BY 不保證留存。
    // item_id 是決勝鍵，同一張單的多列才不會在翻頁時重複或漏列。
    .order('order_date', { ascending: false })
    .order('order_no', { ascending: false })
    .order('item_id', { ascending: true })
    .range(offset, offset + SUPPLIER_PAGE_SIZE - 1);

  if (error) throw error;

  const rows = (data || []).map(row => ({
    itemId: row.item_id,
    orderNo: row.order_no,
    orderDate: row.order_date,
    type: row.type,
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    // 進貨退出列為負數，與 amount 同號
    qty: Number(row.qty) || 0,
    unitPrice: Number(row.unit_price) || 0,
    amount: Number(row.amount) || 0
  }));

  return { rows, total: count || 0 };
}

// 目前未付餘額：複用收付款頁那支 get_partner_balances（p_partner_type = 'supplier' 時算應付）。
// 與客戶的未收餘額同理，這是「全期間期末快照」，不是查詢區間的發生額，呈現時必須標註。
export async function fetchSupplierOutstanding(partnerId) {
  const { data, error } = await sb.rpc('get_partner_balances', {
    p_partner_id: partnerId,
    p_partner_type: 'supplier'
  });

  if (error) throw error;

  const row = data?.[0];
  // 查不到代表沒有任何進貨與付款紀錄，餘額就是 0，不是錯誤。
  return row ? Number(row.balance) || 0 : 0;
}
