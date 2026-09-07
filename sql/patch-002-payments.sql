-- ============================================================
-- Patch 002：收款單 + 對帳單
-- 適用：已執行過 migration.sql（+ patch-001）的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================

-- ============================================
-- partners 加客戶編號（對帳單表頭用，例：1294-1）
-- ============================================
alter table partners add column partner_no text unique;

-- ============================================
-- 收款單（簡單版：只記客戶 + 金額，不沖特定單據）
-- ============================================
create table payments (
  id            uuid primary key default gen_random_uuid(),
  payment_no    text unique not null,
  partner_id    uuid not null references partners(id),
  payment_date  date not null default current_date,
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'cash'
                check (method in ('cash','transfer','check')),
  note          text,
  created_at    timestamptz default now()
);

create index idx_payments_partner on payments (partner_id, payment_date desc);
create index idx_payments_date    on payments (payment_date desc);

alter table payments enable row level security;
create policy "anon full access" on payments
  for all to anon using (true) with check (true);

-- ============================================
-- 客戶應收餘額 View
-- 應收餘額 = 已確認出貨(sale)總額 − 累計收款
-- ============================================
create view partner_balance_view as
with sales as (
  select o.partner_id,
         sum(coalesce(items.item_total, 0) - o.discount + o.tax) as total_sales
  from orders o
  left join (
    select order_id, sum(subtotal) as item_total
    from order_items
    group by order_id
  ) items on items.order_id = o.id
  where o.type = 'sale' and o.status = 'confirmed'
  group by o.partner_id
),
paid as (
  select partner_id, sum(amount) as total_paid
  from payments
  group by partner_id
)
select
  p.id, p.partner_no, p.name, p.type, p.phone,
  coalesce(s.total_sales, 0) as total_sales,
  coalesce(pa.total_paid, 0) as total_paid,
  coalesce(s.total_sales, 0) - coalesce(pa.total_paid, 0) as balance
from partners p
left join sales s on s.partner_id = p.id
left join paid  pa on pa.partner_id = p.id
where p.type = 'customer';

-- ============================================
-- 對帳單明細 View（一行 = 一筆出貨明細，含單據與商品資訊）
-- 前端以 partner_id + 日期區間查詢組出對帳單
-- ============================================
create view statement_line_view as
select
  o.partner_id,
  o.order_date,
  o.order_no,
  o.id as order_id,
  pr.name as product_name,
  pr.spec,
  abs(oi.qty) as qty,
  pr.unit,
  oi.unit_price,
  oi.subtotal
from orders o
join order_items oi on oi.order_id = o.id
join products pr    on pr.id = oi.product_id
where o.type = 'sale' and o.status = 'confirmed';
