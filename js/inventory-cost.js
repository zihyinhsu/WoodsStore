import { sb } from './supabase.js';
import { PAGE_SIZE } from './utils.js';

// 分頁筆數全站一致，直接沿用 utils.js 的 PAGE_SIZE，不另外宣告數字。
// 這兩個名稱保留是為了讓呼叫端讀起來知道分的是哪一種資料。
export const COST_PAGE_SIZE = PAGE_SIZE;
export const MOVEMENT_PAGE_SIZE = PAGE_SIZE;

export async function fetchCostPage({ from, to, page }) {
  const offset = (page - 1) * COST_PAGE_SIZE;

  // 固定只取期間內有進出貨的商品。RPC 的 p_with_movement_only 預設為 false，
  // 省略這個參數會退回「列出全部商品」，因此必須顯式傳 true。
  const { data, count, error } = await sb
    .rpc('product_cost_analysis', {
      p_from: from,
      p_to: to,
      p_with_movement_only: true
    }, { count: 'exact' })
    .order('sku', { ascending: true })
    .range(offset, offset + COST_PAGE_SIZE - 1);

  if (error) throw error;
  return { rows: data || [], total: count || 0 };
}

export async function fetchCostTotals(from, to) {
  const { data, error } = await sb
    .rpc('product_cost_analysis_summary', { p_from: from, p_to: to });

  if (error) throw error;

  const totals = data?.[0] || { purchase_amount: 0, sale_amount: 0, estimated_cost: 0 };
  const saleAmount = Number(totals.sale_amount);
  const estimatedCost = Number(totals.estimated_cost);

  return {
    purchaseAmount: Number(totals.purchase_amount),
    saleAmount,
    estimatedCost,
    estimatedProfit: saleAmount - estimatedCost
  };
}

// 按月進出貨趨勢。總覽的圖表面板已改談客戶毛利（patch-026），這支目前沒有呼叫端；
// 保留的理由同下方 fetchPeriodSummary：cost_trend 仍在正式庫裡，要把趨勢圖加回來
// （例如放進「商品明細」分頁）時切個資料源即可，不必從頭再寫一次 RPC 與轉型。
// RPC 已按月分組排序，這裡只把數值轉成 Number，讓圖表層拿到乾淨的資料結構。
export async function fetchCostTrend(from, to) {
  const { data, error } = await sb.rpc('cost_trend', {
    p_from: toDateParam(from),
    p_to: toDateParam(to)
  });

  if (error) throw error;

  return (data || []).map(row => ({
    month: row.month,
    purchaseAmount: Number(row.purchase_amount),
    saleAmount: Number(row.sale_amount),
    estimatedProfit: Number(row.estimated_profit)
  }));
}

// 商品毛利排行。同 fetchCostTrend：總覽的排行圖已換成客戶維度，這支暫無呼叫端但保留。
// RPC 已回頭尾各 limit 名、由高到低排好，前端直接照順序畫，負毛利再於圖表層改色。
export async function fetchCostRanking(from, to, limit = 5) {
  const { data, error } = await sb.rpc('cost_ranking', {
    p_from: toDateParam(from),
    p_to: toDateParam(to),
    p_limit: limit
  });

  if (error) throw error;

  return (data || []).map(row => ({
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    estimatedProfit: Number(row.estimated_profit)
  }));
}

// 日期沒填代表「累計」（不限該側）。傳空字串給 date 參數 Postgres 會直接報錯，
// 因此一律轉成 null，由 SQL 端的 `p_from is null or ...` 判斷。
function toDateParam(value) {
  return value || null;
}

export async function fetchProductCostSummary(productId, from, to) {
  const { data, error } = await sb.rpc('product_cost_detail_summary', {
    p_product_id: productId,
    p_from: toDateParam(from),
    p_to: toDateParam(to)
  });

  if (error) throw error;

  const row = data?.[0] || {};
  const purchaseQty = Number(row.purchase_qty) || 0;
  const purchaseAmount = Number(row.purchase_amount) || 0;
  const saleQty = Number(row.sale_qty) || 0;
  const saleAmount = Number(row.sale_amount) || 0;
  // cost 為出貨成本快照合計（Σ unit_cost × 數量），毛利與平均出貨成本都以它為基礎。
  const cost = Number(row.cost) || 0;

  return { purchaseQty, purchaseAmount, saleQty, saleAmount, cost };
}

export async function fetchProductMovementPage({ productId, from, to, page }) {
  const offset = (page - 1) * MOVEMENT_PAGE_SIZE;

  const { data, count, error } = await sb
    .rpc('product_cost_movements', {
      p_product_id: productId,
      p_from: toDateParam(from),
      p_to: toDateParam(to)
    }, { count: 'exact' })
    // 排序在這裡再指定一次，不是多餘的：SQL function 被 inline 之後外層會多包一層
    // SELECT，函式內部的 ORDER BY 不保證留存。少了這行，翻頁會出現重複或漏列的紀錄。
    .order('order_date', { ascending: false })
    .order('order_no', { ascending: false })
    .order('item_id', { ascending: false })
    .range(offset, offset + MOVEMENT_PAGE_SIZE - 1);

  if (error) throw error;
  return { rows: data || [], total: count || 0 };
}

// 含稅（收付視角）的期間損益：revenue／expense 為明細小計 − 整單折讓 + 稅額，
// cost／profit 則是未稅。總覽四張卡已改吃 fetchCostTotals 的全未稅口徑，這支目前沒有呼叫端，
// 保留是因為「含稅檢視」是預定要做的功能，屆時切資料源即可，不必再從頭寫一次 RPC。
export async function fetchPeriodSummary(from, to) {
  const { data, error } = await sb.rpc('dashboard_summary', { p_from: from, p_to: to });
  if (error) throw error;

  const summary = data?.[0] || { revenue: 0, expense: 0, cost: 0, profit: 0 };
  return {
    revenue: Number(summary.revenue),
    expense: Number(summary.expense),
    cost: Number(summary.cost),
    // 未稅毛利由 SQL 端算好（含折讓、未稅）。前端別再用含稅的 revenue 減成本，那會灌水。
    profit: Number(summary.profit)
  };
}
