-- ============================================================
-- Patch 020：報表改讀成本快照（Stage 3）
-- 適用：已執行過 patch-018 + patch-019、且 backfill 已跑完的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
--
-- 這是「切換讀取口徑」的 patch，必須排在 backfill（patch-018）之後：
-- 一旦報表改讀 order_items.unit_cost，尚未回填的歷史明細會被當成成本 0，毛利虛高。
--
-- 口徑改動：出貨成本從「查詢區間內進貨均價 × 出貨量」改為
-- 「Σ(每筆出貨的成本快照 unit_cost × 該筆數量)」。快照在確認當下寫定（見 patch-018/019），
-- 因此成本不再隨查詢區間漂移，也不受事後改 products.cost 影響。
--
-- 對外介面刻意不變：product_cost_analysis / _summary / dashboard_summary 的
-- 回傳欄位（estimated_cost、cost 等）與名稱都保留，前端無需改動。
-- 只有 product_movement 這支「內部」函式的回傳欄位由 unit_cost 換成 cost。
-- ============================================================

-- ============================================
-- 進出貨明細基底：補上 unit_cost，供出貨成本加總
-- ============================================
create or replace view product_movement_base as
select
  oi.product_id,
  o.order_date,
  o.type,
  abs(oi.qty) as qty,
  oi.subtotal,
  oi.unit_cost
from orders o
join order_items oi on oi.order_id = o.id
where o.status = 'confirmed'
  and o.type in ('purchase', 'sale');

-- product_movement 的回傳欄位要換（unit_cost → cost），create or replace 無法改
-- OUT 欄位，必須先 drop。它被下面三支函式引用，Postgres 會擋 drop，故連同一起重建。
drop function if exists dashboard_summary(date, date);
drop function if exists product_cost_analysis(date, date, boolean);
drop function if exists product_cost_analysis_summary(date, date);
drop function if exists product_movement(date, date);

-- ============================================
-- 期間內逐商品的進出貨彙總與出貨成本
-- cost = Σ(出貨明細的成本快照 × 該筆數量)。unit_cost 可能為 null
--（該商品出貨當下既無進貨、products.cost 也為 null），以 0 計入，代表成本未知。
-- 不再 join products 取現行進價：成本一律來自寫定的快照，不受現價變動影響。
-- ============================================
create or replace function product_movement(
  p_from date,
  p_to date
) returns table (
  product_id uuid,
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric,
  cost numeric
)
language sql
stable
security invoker
as $$
  select
    m.product_id,
    coalesce(sum(m.qty)      filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.subtotal) filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.qty)      filter (where m.type = 'sale'), 0),
    coalesce(sum(m.subtotal) filter (where m.type = 'sale'), 0),
    coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.type = 'sale'), 0)
  from product_movement_base m
  where m.order_date between p_from and p_to
  group by m.product_id;
$$;

-- ============================================
-- 期間損益彙總
-- 收益／支出口徑不變；成本改為 Σ 各商品的出貨成本快照。
-- ============================================
create or replace function dashboard_summary(
  p_from date,
  p_to date
) returns table (
  revenue numeric,
  expense numeric,
  cost numeric
)
language sql
stable
security invoker
as $$
  with order_totals as (
    select
      o.id,
      o.type,
      coalesce(sum(oi.subtotal), 0) - o.discount + o.tax as net_amount
    from orders o
    left join order_items oi on oi.order_id = o.id
    where o.status = 'confirmed'
      and o.type in ('purchase', 'sale')
      and o.order_date between p_from and p_to
    group by o.id
  )
  select
    coalesce(sum(net_amount) filter (where type = 'sale'), 0),
    coalesce(sum(net_amount) filter (where type = 'purchase'), 0),
    (select coalesce(sum(cost), 0) from product_movement(p_from, p_to))
  from order_totals;
$$;

-- ============================================
-- 逐商品進出貨成本分析
-- estimated_cost = 出貨成本快照；estimated_profit = 出貨金額 − 成本。
-- 名稱維持 estimated_*：欄位含意仍是「估算」（純累計均價、非移動平均），前端不動。
-- ============================================
create or replace function product_cost_analysis(
  p_from date,
  p_to date,
  p_with_movement_only boolean default false
) returns table (
  product_id uuid,
  sku text,
  name text,
  unit text,
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric,
  estimated_cost numeric,
  estimated_profit numeric
)
language sql
stable
security invoker
as $$
  select
    p.id,
    p.sku,
    p.name,
    p.unit,
    coalesce(m.purchase_qty, 0),
    coalesce(m.purchase_amount, 0),
    coalesce(m.sale_qty, 0),
    coalesce(m.sale_amount, 0),
    coalesce(m.cost, 0),
    coalesce(m.sale_amount - m.cost, 0)
  from products p
  left join product_movement(p_from, p_to) m on m.product_id = p.id
  where m.product_id is not null or not p_with_movement_only;
$$;

-- ============================================
-- 上述分析的期間合計
-- ============================================
create or replace function product_cost_analysis_summary(
  p_from date,
  p_to date
) returns table (
  purchase_amount numeric,
  sale_amount numeric,
  estimated_cost numeric
)
language sql
stable
security invoker
as $$
  select
    coalesce(sum(purchase_amount), 0),
    coalesce(sum(sale_amount), 0),
    coalesce(sum(cost), 0)
  from product_movement(p_from, p_to);
$$;

-- ============================================
-- 單一商品的期間彙總：新增出貨成本快照 cost
-- cost = Σ(出貨明細 unit_cost × abs(qty))，供商品頁毛利與「平均出貨成本」卡使用。
-- 新增 OUT 欄位一樣要先 drop 再建。調整單不列入（與進出貨量、金額同一過濾原則）。
-- ============================================
drop function if exists product_cost_detail_summary(uuid, date, date);

create or replace function product_cost_detail_summary(
  p_product_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric,
  cost numeric
)
language sql
stable
security invoker
as $$
  select
    coalesce(sum(abs(oi.qty)) filter (where o.type = 'purchase'), 0),
    coalesce(sum(oi.subtotal) filter (where o.type = 'purchase'), 0),
    coalesce(sum(abs(oi.qty)) filter (where o.type = 'sale'), 0),
    coalesce(sum(oi.subtotal) filter (where o.type = 'sale'), 0),
    coalesce(sum(coalesce(oi.unit_cost, 0) * abs(oi.qty)) filter (where o.type = 'sale'), 0)
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.product_id = p_product_id
    and o.status = 'confirmed'
    and (p_from is null or o.order_date >= p_from)
    and (p_to   is null or o.order_date <= p_to);
$$;
