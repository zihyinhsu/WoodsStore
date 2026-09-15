-- patch-021-order-discount-allocation
-- 進出貨成本分析：整單折讓分攤 + 毛利口徑修正
--
-- 背景：明細表／趨勢圖／排行圖／商品頁原本只取 order_items.subtotal（含明細折扣、
-- 但不含整單折讓、不含稅），毛利會因忽略整單折讓而高估；而總覽「本月毛利」卡則反向，
-- 用含稅的 revenue 去減未稅成本，毛利被稅額灌水。
--
-- 本 patch 統一為：進/出貨金額 = 未稅、已含整單折讓（整單折讓按明細小計比例分攤）；
-- 毛利一律未稅。上方「進貨支出／出貨收益」兩張卡片維持含稅（收付視角，UI 已標注含稅）。
--
-- 依相依順序執行（product_movement_base -> product_movement / cost_trend ->
-- product_cost_detail_summary -> dashboard_summary）。schema.sql 已同步更新。

-- ------------------------------------------------------------------
-- 1. 明細來源 view：每列帶「分到的整單折讓」
--    新欄位放在 select 尾端（unit_cost 之後）：create or replace view 只能在尾端
--    追加欄位，插在既有欄位之間會報 42P16 cannot change name of view column。
--    欄位順序對下游沒差（都以欄名引用），這樣即可純追加、免 drop、不影響相依 function。
-- ------------------------------------------------------------------
create or replace view product_movement_base as
select
  oi.product_id,
  o.order_date,
  o.type,
  abs(oi.qty) as qty,
  oi.subtotal,
  oi.unit_cost,
  -- 整單折讓掛在單、不掛在商品，按明細小計比例分攤到本列，毛利才不會因忽略折讓而高估。
  -- 保持全精度不 round：同一單各列分攤和恆等於整單折讓，合計不會因逐列進位而漂移。
  -- 整單小計為 0 卻有折讓的異常單以 nullif 防除零，該情況不分攤。
  o.discount * oi.subtotal
    / nullif(sum(oi.subtotal) over (partition by oi.order_id), 0) as order_discount_alloc
from orders o
join order_items oi on oi.order_id = o.id
where o.status = 'confirmed'
  and o.type in ('purchase', 'sale');

-- ------------------------------------------------------------------
-- 2. 逐商品彙總：進/出貨金額改吃扣掉分攤折讓後的淨額
--    （product_cost_analysis / _summary、cost_ranking 都走這支，會自動同口徑）
-- ------------------------------------------------------------------
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
    -- 進/出貨金額扣掉分攤到本列的整單折讓（未稅、含折讓）；數量與成本快照不受折讓影響。
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.qty)      filter (where m.type = 'sale'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'sale'), 0),
    coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.type = 'sale'), 0)
  from product_movement_base m
  where m.order_date between p_from and p_to
  group by m.product_id;
$$;

-- ------------------------------------------------------------------
-- 3. 月度趨勢圖：同口徑改吃淨額
-- ------------------------------------------------------------------
create or replace function cost_trend(
  p_from date,
  p_to date
) returns table (
  month date,
  purchase_amount numeric,
  sale_amount numeric,
  estimated_profit numeric
)
language sql
stable
security invoker
as $$
  with monthly as (
    select
      date_trunc('month', m.order_date)::date as month,
      -- 與 product_movement 同口徑：金額扣掉分攤的整單折讓（未稅、含折讓）。
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'purchase'), 0) as purchase_amount,
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'sale'), 0)     as sale_amount,
      coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.type = 'sale'), 0) as cost
    from product_movement_base m
    where m.order_date between p_from and p_to
    group by date_trunc('month', m.order_date)
  )
  select
    month,
    purchase_amount,
    sale_amount,
    coalesce(sale_amount - cost, 0)
  from monthly
  order by month;
$$;

-- ------------------------------------------------------------------
-- 4. 商品頁彙總：改由 product_movement_base 取數，與總覽同口徑（含折讓、未稅）
-- ------------------------------------------------------------------
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
    coalesce(sum(m.qty) filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.qty) filter (where m.type = 'sale'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'sale'), 0),
    coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.type = 'sale'), 0)
  from product_movement_base m
  where m.product_id = p_product_id
    and (p_from is null or m.order_date >= p_from)
    and (p_to   is null or m.order_date <= p_to);
$$;

-- ------------------------------------------------------------------
-- 5. 期間損益彙總：新增未稅毛利 profit
--    回傳欄位變動，create or replace 不允許改回傳型別，必須先 drop 再 create。
-- ------------------------------------------------------------------
drop function if exists dashboard_summary(date, date);
create function dashboard_summary(
  p_from date,
  p_to date
) returns table (
  revenue numeric,
  expense numeric,
  cost numeric,
  profit numeric
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
  ),
  movement as (
    -- 與明細表同口徑：sale_net 為未稅、已含折讓（product_movement 已扣分攤折讓）。
    select
      coalesce(sum(sale_amount), 0) as sale_net,
      coalesce(sum(cost), 0)        as cost
    from product_movement(p_from, p_to)
  )
  select
    coalesce(sum(net_amount) filter (where type = 'sale'), 0),
    coalesce(sum(net_amount) filter (where type = 'purchase'), 0),
    (select cost from movement),
    (select sale_net - cost from movement)
  from order_totals;
$$;
