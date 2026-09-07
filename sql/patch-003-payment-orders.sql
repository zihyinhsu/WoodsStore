-- ============================================================
-- Patch 003：收款沖帳（收款單關聯出貨單）
-- 適用：已執行過 migration.sql + patch-002 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================

-- ============================================
-- 收款 ↔ 出貨單 關聯表（一筆收款可沖多張出貨單）
-- ============================================
create table payment_orders (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references payments(id) on delete cascade,
  order_id    uuid not null references orders(id),
  unique (payment_id, order_id)
);

create index idx_payment_orders_payment on payment_orders (payment_id);
create index idx_payment_orders_order   on payment_orders (order_id);

alter table payment_orders enable row level security;
create policy "anon full access" on payment_orders
  for all to anon using (true) with check (true);

-- ============================================
-- 客戶未沖帳出貨單 View
-- 已確認出貨單中，尚未被任何收款單沖帳者（收款表單勾選清單用）
-- ============================================
create view unpaid_order_view as
select
  o.id, o.partner_id, o.order_no, o.order_date,
  coalesce(items.item_total, 0) - o.discount + o.tax as order_total
from orders o
left join (
  select order_id, sum(subtotal) as item_total
  from order_items
  group by order_id
) items on items.order_id = o.id
where o.type = 'sale'
  and o.status = 'confirmed'
  and not exists (
    select 1 from payment_orders po where po.order_id = o.id
  );
