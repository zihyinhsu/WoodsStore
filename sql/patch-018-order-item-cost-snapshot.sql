-- ============================================================
-- Patch 018：order_items 成本快照（Stage 1 + Stage 2）
-- 適用：已執行過 migration.sql + patch-001~017 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
--
-- 為什麼要做：
--   出貨成本原本以「查詢區間內進貨均價」即時推算（見 patch-008），有兩個結構性缺陷：
--     1. 視窗依賴：成本＝所選查詢區間內的進貨均價，改區間就變。
--     2. 可變性：無進貨期間退回 products.cost，改進價就追溯改寫歷史毛利。
--   本 patch 在 order_items 存一份確認當下的成本快照，把成本綁在那筆出貨上。
--
-- 成本方法（方案 A）：截至出貨日的累計進貨加權平均 + 確認時快照。
--   出貨成本 = Σ(截至該出貨 order_date、已確認進貨的 subtotal) / Σ(對應進貨量)。
--   選 A 而非「永續移動平均」的理由：A 能由 order_items 流水帳完全重算，
--   不必維護任何 running 狀態欄位，貼合本專案「不存衍生狀態、一切由流水帳推導」的精神。
--   代價：純累計、不隨出貨扣減成本池，進價長期走高時均價會略低於「當下這批」的實際成本。
--
-- 前提與取捨：
--   1. 成本以 order_date 為時序。出貨要有成本，前提是該出貨日之前已有該商品的
--      已確認進貨；沒有就 fallback products.cost。「銷貨先開、進貨後補」的早期資料會落在 fallback。
--   2. 快照確認當下寫定、不追溯。事後 backdate 更早的進貨、或作廢先前進貨，
--      都不改寫已確認出貨的成本——與「單據不可編輯」一致。
--   3. 成本基礎用 subtotal（含明細折扣、不含整單折讓與稅），與現行口徑一致。
--   4. 調整單（adjust）unit_cost 留 null，不進均價分子分母。
-- ============================================================

-- ============================================
-- Stage 1a：新增成本快照欄位
-- nullable：草稿明細與調整單本來就沒有成本；歷史資料在下方 backfill 補齊。
-- ============================================
alter table order_items add column if not exists unit_cost numeric(12,2);

-- ============================================
-- Stage 1b：截至某日的累計進貨加權平均
-- 分母用 abs(qty)：進貨 qty 為正，abs() 只是與流水帳其他統計保持一致的防呆。
-- 無已確認進貨時 sum 為 null、nullif 也擋掉除以零，整體回傳 null，
-- 交給呼叫端 fallback products.cost。
-- ============================================
create or replace function purchase_avg_cost_asof(
  p_product_id uuid,
  p_as_of date
) returns numeric
language sql
stable
security invoker
as $$
  select sum(oi.subtotal) / nullif(sum(abs(oi.qty)), 0)
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.product_id = p_product_id
    and o.status = 'confirmed'
    and o.type = 'purchase'
    and o.order_date <= p_as_of;
$$;

-- ============================================
-- Stage 1c：把一張單的明細成本寫定
-- 建單/確認（patch-019）與下方 backfill 共用這支，確保三處口徑完全一致，
-- 不會出現「歷史用一套算法、新單用另一套」的漂移。
--
-- 進貨：實付單價 = subtotal / abs(qty)（subtotal 已含明細折扣）。
-- 出貨：as-of 累計進貨均價，無進貨退回 products.cost。
-- 調整單不在任何一條 update 的範圍內，unit_cost 維持 null。
-- ============================================
create or replace function snapshot_order_item_costs(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  update order_items oi
  set unit_cost = round(oi.subtotal / nullif(abs(oi.qty), 0), 2)
  from orders o
  where oi.order_id = p_order_id
    and o.id = oi.order_id
    and o.type = 'purchase';

  update order_items oi
  set unit_cost = round(coalesce(
        purchase_avg_cost_asof(oi.product_id, o.order_date),
        p.cost
      ), 2)
  from orders o
  join products p on p.id = oi.product_id
  where oi.order_id = p_order_id
    and o.id = oi.order_id
    and o.type = 'sale';
end $$;

-- ============================================
-- Stage 1d：回填既有已確認明細
-- 逐單呼叫 snapshot_order_item_costs，重用與寫入路徑相同的邏輯。
-- 資料量是「單據數」而非「明細數」，一次性 backfill 的成本可接受。
-- 只回填 confirmed：草稿明細的成本要等確認當下才定，維持 null。
-- ============================================
do $$
declare
  v_order_id uuid;
begin
  for v_order_id in
    select id from orders
    where status = 'confirmed'
      and type in ('purchase', 'sale')
  loop
    perform snapshot_order_item_costs(v_order_id);
  end loop;
end $$;
