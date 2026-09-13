-- ============================================================
-- patch-008：總覽報表（本月收益／支出／成本 + 進出貨成本分析）
-- 聚合一律在資料庫做，前端只拿彙總後的結果並分頁。
-- ============================================================

-- ============================================
-- 低庫存 View（總覽卡片與清單共用，避免前端抓全表再過濾）
-- ============================================
create or replace view low_stock_view as
select *
from stock_view
where stock_qty < safety_stock;

-- ============================================
-- 期間內逐商品的進出貨彙總與單位成本
-- 單位成本 = 期間內進貨均價，與商品頁的成本分析同一口徑；
-- 期間內沒進貨的商品沒有均價可算，退回商品現行進價。
-- ============================================
create or replace view product_movement_base as
select
  oi.product_id,
  o.order_date,
  o.type,
  abs(oi.qty) as qty,
  oi.subtotal
from orders o
join order_items oi on oi.order_id = o.id
where o.status = 'confirmed'
  and o.type in ('purchase', 'sale');

create or replace function product_movement(
  p_from date,
  p_to date
) returns table (
  product_id uuid,
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric,
  unit_cost numeric
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
    coalesce(
      sum(m.subtotal) filter (where m.type = 'purchase')
        / nullif(sum(m.qty) filter (where m.type = 'purchase'), 0),
      p.cost
    )
  from product_movement_base m
  join products p on p.id = m.product_id
  where m.order_date between p_from and p_to
  group by m.product_id, p.cost;
$$;

-- ============================================
-- 期間損益彙總
-- 收益／支出 = 明細小計 − 整單折讓 + 稅額，與 partner_balance_view 一致。
-- 成本 = Σ(出貨數量 × 該商品期間單位成本)。
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
    (select coalesce(sum(sale_qty * unit_cost), 0) from product_movement(p_from, p_to))
  from order_totals;
$$;

-- ============================================
-- 逐商品進出貨成本分析
-- 回傳一商品一列；前端以 order/range 分頁，不搬明細到瀏覽器。
-- p_with_movement_only = true 時只留期間內有進出貨的商品。
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
    coalesce(m.sale_qty * m.unit_cost, 0),
    coalesce(m.sale_amount - m.sale_qty * m.unit_cost, 0)
  from products p
  left join product_movement(p_from, p_to) m on m.product_id = p.id
  where m.product_id is not null or not p_with_movement_only;
$$;

-- ============================================
-- 上述分析的期間合計
-- 金額為「明細小計加總」，與逐商品列相加得出的數字一致；
-- 因此不含整單折讓與稅額，與 dashboard_summary 的淨額口徑不同。
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
    coalesce(sum(sale_qty * unit_cost), 0)
  from product_movement(p_from, p_to);
$$;

-- ============================================
-- 支援報表查詢的索引
-- ============================================
create index if not exists idx_orders_status_type_date
  on orders (status, type, order_date);

-- ============================================
-- 成本口徑（重要）
-- order_items 只保存售價（unit_price），沒有出貨當下的進價快照，
-- 因此出貨成本以「期間內進貨均價」估算，與商品頁成本分析同一口徑；
-- 期間內沒有進貨紀錄的商品，退回商品現行進價（products.cost）。
-- 兩者都是估算值：查詢區間或商品進價一改，歷史成本與毛利就會變動。
-- 若要精確的歷史成本，需在 order_items 增加成本欄位並於建單時寫入快照。
-- ============================================
