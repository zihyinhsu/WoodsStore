-- patch-032-supplier-purchases
-- 供應商進貨報表：總覽「供應商進貨」分頁與供應商進貨 modal 的資料來源。
--
-- 動 SQL 前必須知道的事：
--   - 口徑與總覽卡片「本月進貨成本」（product_cost_analysis_summary）完全一致：
--     都從 product_movement_base 的 flow = 'purchase' 取數，未稅、已扣分攤整單折讓，
--     進貨退出以負數併入。所以各供應商淨進貨加總會等於卡片數字，
--     差額只有兩種：未指定供應商（partner_id 為 null）的進貨單，以及逐供應商進位到分的尾差。
--   - product_movement_base 在尾端追加 item_id：modal 要列到明細層級（品名、單價），
--     又要沿用同一套折讓分攤算式；另寫一份分攤算式就會出現兩個「進貨金額」。
--     create or replace view 會用這次給的 with (...) 取代原本的 reloptions，
--     正式庫的 view 可能帶 security_invoker 之類的選項（patch-031 也是照原樣還原），
--     所以先存下來、改完再設回去。
--   - 新函式明確撤掉 public／anon 的 execute：Postgres 建函式預設開放 public 執行，
--     schema.sql 的 default privileges 只撤 anon、撤不到 public。
--
-- 整份在一個交易內，可重複執行。

begin;

-- ============================================================
-- 1. product_movement_base 尾端追加 item_id（保留原本的 reloptions）
-- ============================================================
create temp table _pmb_options on commit drop as
select c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'product_movement_base';

create or replace view product_movement_base as
select
  oi.product_id,
  o.order_date,
  o.type,
  (abs(oi.qty) * order_amount_sign(o.type)) as qty,
  (order_amount_sign(o.type) * oi.subtotal)::numeric(12,2) as subtotal,
  oi.unit_cost,
  order_amount_sign(o.type) * o.discount * oi.subtotal
    / nullif(sum(oi.subtotal) over (partition by oi.order_id), 0) as order_discount_alloc,
  o.partner_id,
  o.id as order_id,
  case when o.type in ('sale', 'sale_return') then 'sale' else 'purchase' end as flow,
  oi.id as item_id
from orders o
join order_items oi on oi.order_id = o.id
where o.status = 'confirmed'
  and o.type in ('purchase', 'sale', 'sale_return', 'purchase_return');

do $$
declare
  v_options text[];
begin
  select reloptions into v_options from _pmb_options;
  if v_options is not null then
    execute format('alter view public.product_movement_base set (%s)',
      array_to_string(v_options, ', '));
  end if;
end $$;

-- ============================================================
-- 2. 函式
-- ============================================================

-- 逐供應商進貨（一供應商一列；排序與分頁交給前端，同 partner_profit）
-- 只回期間內有進貨或進貨退出的供應商。只有退出、沒有進貨的供應商淨額為負，保留：那就是該期的真實數字。
-- order_count、last_purchase_date 只算 type = 'purchase'，否則「最後進貨日」會變成退貨日。
-- 淨額由兩個已進位的欄位相加，而不是另外 sum 一次：清單上「進貨 + 退出 = 淨額」必須逐列對得起來。
create or replace function supplier_purchase(
  p_from date default null,
  p_to date default null,
  p_keyword text default null,
  p_partner_id uuid default null
) returns table (
  partner_id uuid,
  partner_no text,
  name text,
  purchase_amount numeric,
  return_amount numeric,
  net_amount numeric,
  order_count bigint,
  return_count bigint,
  last_purchase_date date
)
language sql
stable
security invoker
as $$
  with params as (
    select nullif(btrim(coalesce(p_keyword, '')), '') as keyword
  ),
  pattern as (
    -- 與 get_partner_balances、partner_profit 同一段跳脫寫法。
    select
      case
        when pm.keyword is null then null
        else '%' || replace(replace(replace(pm.keyword, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as like_pattern
    from params pm
  ),
  agg as (
    select
      m.partner_id,
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0))
        filter (where m.type = 'purchase'), 0)::numeric(12,2)        as purchase_amount,
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0))
        filter (where m.type = 'purchase_return'), 0)::numeric(12,2) as return_amount,
      count(distinct m.order_id) filter (where m.type = 'purchase')        as order_count,
      count(distinct m.order_id) filter (where m.type = 'purchase_return') as return_count,
      max(m.order_date)          filter (where m.type = 'purchase')        as last_purchase_date
    from product_movement_base m
    where m.flow = 'purchase'
      and m.partner_id is not null
      and (p_partner_id is null or m.partner_id = p_partner_id)
      and (p_from is null or m.order_date >= p_from)
      and (p_to   is null or m.order_date <= p_to)
    group by m.partner_id
  )
  select
    p.id,
    p.partner_no,
    p.name,
    a.purchase_amount,
    a.return_amount,
    (a.purchase_amount + a.return_amount)::numeric(12,2),
    a.order_count,
    a.return_count,
    a.last_purchase_date
  from agg a
  join partners p on p.id = a.partner_id and p.type = 'supplier'
  cross join pattern pt
  where pt.like_pattern is null
    or p.partner_no           ilike pt.like_pattern escape '\'
    or p.name                 ilike pt.like_pattern escape '\'
    or coalesce(p.tax_id, '') ilike pt.like_pattern escape '\';
$$;

-- 供應商進貨的期間合計。直接對 supplier_purchase 加總，與清單恆等（同 partner_profit_summary）。
create or replace function supplier_purchase_summary(
  p_from date default null,
  p_to date default null,
  p_keyword text default null
) returns table (
  purchase_amount numeric,
  return_amount numeric,
  net_amount numeric,
  supplier_count bigint
)
language sql
stable
security invoker
as $$
  select
    coalesce(sum(sp.purchase_amount), 0)::numeric(12,2),
    coalesce(sum(sp.return_amount), 0)::numeric(12,2),
    coalesce(sum(sp.net_amount), 0)::numeric(12,2),
    count(*)
  from supplier_purchase(p_from, p_to, p_keyword) sp;
$$;

-- 單一供應商的進貨明細（modal 下方；前端分頁）
-- amount 是本列扣掉分攤整單折讓後的金額，與上方彙總同一口徑；
-- 逐列進位到分，整單有折讓時各列加總可能與彙總差一兩分，彙總以 supplier_purchase 為準。
-- 排序在前端指定（function inline 後內部 ORDER BY 不保證留存，見 product_cost_movements）。
create or replace function supplier_purchase_items(
  p_partner_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  item_id uuid,
  order_no text,
  order_date date,
  type text,
  product_id uuid,
  sku text,
  name text,
  unit text,
  qty numeric,
  unit_price numeric,
  amount numeric
)
language sql
stable
security invoker
as $$
  select
    m.item_id,
    o.order_no,
    m.order_date,
    m.type,
    pr.id,
    pr.sku,
    pr.name,
    pr.unit,
    m.qty,
    oi.unit_price,
    (m.subtotal - coalesce(m.order_discount_alloc, 0))::numeric(12,2)
  from product_movement_base m
  join orders o       on o.id = m.order_id
  join order_items oi on oi.id = m.item_id
  join products pr    on pr.id = m.product_id
  where m.flow = 'purchase'
    and m.partner_id = p_partner_id
    and (p_from is null or m.order_date >= p_from)
    and (p_to   is null or m.order_date <= p_to);
$$;

revoke execute on function supplier_purchase(date, date, text, uuid)  from public, anon;
revoke execute on function supplier_purchase_summary(date, date, text) from public, anon;
revoke execute on function supplier_purchase_items(uuid, date, date)   from public, anon;
grant  execute on function supplier_purchase(date, date, text, uuid)  to authenticated;
grant  execute on function supplier_purchase_summary(date, date, text) to authenticated;
grant  execute on function supplier_purchase_items(uuid, date, date)   to authenticated;

-- 讓 PostgREST 立即重讀 schema，否則前端在快取過期前呼叫新函式會拿到 404。
notify pgrst, 'reload schema';

commit;
