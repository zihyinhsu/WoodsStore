// ============================================================
// 客戶毛利的資料存取層：包裝 patch-026 的 RPC，回傳整理過的結果。
// 頁面模組（dashboard.js / partners.js）不直接碰 sb.rpc，與 inventory-cost.js 同分工。
//
// 口徑一律由 SQL 端決定（未稅、已扣分攤整單折讓、成本讀 unit_cost 快照），
// 這裡只做型別轉換：Postgres numeric 經 REST 回來是字串，直接拿去運算會變字串相接。
// ============================================================
import { sb } from './supabase.js';
import { PAGE_SIZE } from './utils.js';

export const PROFIT_PAGE_SIZE = PAGE_SIZE;

// 排行圖取毛利最高／最低各幾名（RPC 的 p_limit），與總覽原本的商品排行同一個數字。
export const PROFIT_RANKING_LIMIT = 5;

// 日期沒填代表「累計」（不限該側）。傳空字串給 date 參數 Postgres 會直接報錯，
// 因此一律轉成 null，由 SQL 端的 `p_from is null or ...` 判斷。
function toDateParam(value) {
  return value || null;
}

// 關鍵字同理：空字串與 null 在 SQL 端都視為不篩選，統一在這裡收斂。
function toKeywordParam(value) {
  const keyword = (value || '').trim();
  return keyword || null;
}

function toProfitRow(row) {
  const saleAmount = Number(row.sale_amount) || 0;
  const cost = Number(row.cost) || 0;

  return {
    partnerId: row.partner_id,
    partnerNo: row.partner_no,
    name: row.name,
    saleAmount,
    cost,
    profit: Number(row.profit) || 0,
    orderCount: Number(row.order_count) || 0,
    lastSaleDate: row.last_sale_date,
    // 成本未知的出貨量 > 0 時毛利偏高，由呈現層決定怎麼提醒。
    noCostQty: Number(row.no_cost_qty) || 0
  };
}

export async function fetchPartnerProfitPage({ from, to, keyword, page }) {
  const offset = (page - 1) * PROFIT_PAGE_SIZE;

  const { data, count, error } = await sb
    .rpc('partner_profit', {
      p_from: toDateParam(from),
      p_to: toDateParam(to),
      p_keyword: toKeywordParam(keyword)
    }, { count: 'exact' })
    // partner_no 是決勝鍵，不是裝飾：毛利相同的客戶若沒有第二排序鍵，
    // 翻頁時每次查詢的順序可能不同，同一筆會重複出現或整筆被跳過。
    .order('profit', { ascending: false })
    .order('partner_no', { ascending: true })
    .range(offset, offset + PROFIT_PAGE_SIZE - 1);

  if (error) throw error;
  return { rows: (data || []).map(toProfitRow), total: count || 0 };
}

export async function fetchPartnerProfitTotals(from, to, keyword) {
  const { data, error } = await sb.rpc('partner_profit_summary', {
    p_from: toDateParam(from),
    p_to: toDateParam(to),
    p_keyword: toKeywordParam(keyword)
  });

  if (error) throw error;

  const totals = data?.[0] || {};
  return {
    saleAmount: Number(totals.sale_amount) || 0,
    cost: Number(totals.cost) || 0,
    profit: Number(totals.profit) || 0,
    customerCount: Number(totals.customer_count) || 0
  };
}

// 排行圖用。RPC 已回頭尾各 limit 名、由高到低排好，前端照順序畫，負毛利再於圖表層改色。
export async function fetchPartnerProfitRanking(from, to, keyword, limit = PROFIT_RANKING_LIMIT) {
  const { data, error } = await sb.rpc('partner_profit_ranking', {
    p_from: toDateParam(from),
    p_to: toDateParam(to),
    p_limit: limit,
    p_keyword: toKeywordParam(keyword)
  });

  if (error) throw error;

  // 出貨額／成本／單數只給 tooltip 用（長條本身只畫 profit），
  // 讓滑過去就答得出「這條為什麼這麼長」，不必再去右側表格找同一位客戶。
  //
  // 這三欄是 patch-026 後期才加上的，資料庫若停在早期版本就不會回傳。
  // 此時給 null 而非 0：0 會讓 tooltip 顯示「出貨額 $0、毛利 $800」這種自相矛盾的數字，
  // 看的人會以為資料錯了；null 讓呈現層知道「這裡沒有資料」而少講一句
  //（同 utils.js 的 itemSummary 對未套用 patch-025 的處理）。
  const hasBreakdown = row => row.sale_amount !== undefined;

  return (data || []).map(row => ({
    partnerId: row.partner_id,
    partnerNo: row.partner_no,
    name: row.name,
    profit: Number(row.profit) || 0,
    saleAmount: hasBreakdown(row) ? Number(row.sale_amount) || 0 : null,
    cost: hasBreakdown(row) ? Number(row.cost) || 0 : null,
    orderCount: hasBreakdown(row) ? Number(row.order_count) || 0 : null
  }));
}

// 單一客戶在指定區間的彙總（modal 上方四張卡）。
// 走 partner_profit 的 p_partner_id 而不是拿清單那一列的數字：modal 有自己的區間
// 可以改，沿用清單的數字會在改區間後與下方商品組成對不起來。
// 該客戶在此區間沒有出貨時 RPC 不回任何列，此時回 null 由呈現層顯示空狀態。
export async function fetchPartnerProfitDetail(partnerId, from, to) {
  const { data, error } = await sb.rpc('partner_profit', {
    p_from: toDateParam(from),
    p_to: toDateParam(to),
    p_keyword: null,
    p_partner_id: partnerId
  });

  if (error) throw error;
  return data?.[0] ? toProfitRow(data[0]) : null;
}

export async function fetchPartnerProfitProducts({ partnerId, from, to, page }) {
  const offset = (page - 1) * PROFIT_PAGE_SIZE;

  const { data, count, error } = await sb
    .rpc('partner_profit_products', {
      p_partner_id: partnerId,
      p_from: toDateParam(from),
      p_to: toDateParam(to)
    }, { count: 'exact' })
    // 排序在這裡指定而非寫在 SQL function 內：function 被 inline 之後外層會多包一層
    // SELECT，函式內部的 ORDER BY 不保證留存（同 fetchProductMovementPage 的註解）。
    .order('profit', { ascending: false })
    .order('sku', { ascending: true })
    .range(offset, offset + PROFIT_PAGE_SIZE - 1);

  if (error) throw error;

  const rows = (data || []).map(row => ({
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    saleQty: Number(row.sale_qty) || 0,
    saleAmount: Number(row.sale_amount) || 0,
    cost: Number(row.cost) || 0,
    profit: Number(row.profit) || 0
  }));

  return { rows, total: count || 0 };
}

// 目前未收餘額：複用收款頁那支 get_partner_balances，不另寫 RPC。
// p_partner_id 在 SQL 端凌駕 p_include_settled，已結清的客戶也查得到（回 balance 0）。
// 注意口徑：這是「全期間期末快照」，與毛利的「查詢區間發生額」不是同一把尺，
// 呈現時必須標註，否則會被讀成「這個區間還沒收的錢」。
export async function fetchPartnerOutstanding(partnerId) {
  const { data, error } = await sb.rpc('get_partner_balances', {
    p_partner_id: partnerId
  });

  if (error) throw error;

  const row = data?.[0];
  // 查不到代表這位客戶沒有任何出貨與收款紀錄，餘額就是 0，不是錯誤。
  return row ? Number(row.balance) || 0 : 0;
}
