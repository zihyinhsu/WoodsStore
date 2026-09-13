import { sb } from './supabase.js';

export const COST_PAGE_SIZE = 10;

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

export async function fetchPeriodSummary(from, to) {
  const { data, error } = await sb.rpc('dashboard_summary', { p_from: from, p_to: to });
  if (error) throw error;

  const summary = data?.[0] || { revenue: 0, expense: 0, cost: 0 };
  return {
    revenue: Number(summary.revenue),
    expense: Number(summary.expense),
    cost: Number(summary.cost)
  };
}
