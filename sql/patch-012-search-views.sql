-- ============================================================
-- Patch 012：收款搜尋 View + 付款狀態改讀推導值 + 應收餘額擴充
-- 適用：已執行過 patch-011 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================

-- ============================================
-- 單據搜尋 View：payment_status 改讀推導值
-- 欄位名維持 payment_status，前端不需改讀取路徑。
-- 額外提供 paid_amount / outstanding_amount 供列表顯示已收多少。
-- 非「已確認出貨單」不談應收，payment_status 給 null。
--
-- total_amount 改為淨額（明細小計 − 折讓 + 稅額），與付款狀態的推導同口徑。
-- 舊版是明細小計加總，一張有折讓的單會顯示 $1000 卻在收到 $900 時標記已付款。
-- 此口徑同時與 partner_balance_view、dashboard_summary 一致。
-- ============================================
drop view if exists order_search_view;

create view order_search_view as
select
  o.id, o.order_no, o.type, o.status, o.order_date,
  o.discount, o.tax, o.note, o.created_at,
  o.partner_id,
  p.name as partner_name,
  count(oi.id) as item_count,
  (coalesce(sum(oi.subtotal), 0)
    - coalesce(o.discount, 0)
    + coalesce(o.tax, 0))::numeric(12,2) as total_amount,
  case
    when o.type = 'sale' and o.status = 'confirmed'
      then coalesce(ops.payment_status, 'unpaid')
    else null
  end as payment_status,
  ops.paid_amount,
  ops.outstanding_amount,
  o.order_no || ' ' || coalesce(o.note,'')
    || ' ' || coalesce(p.name,'') || ' ' || coalesce(p.tax_id,'')
    || ' ' || coalesce(string_agg(pr.name || ' ' || pr.sku, ' '), '')
    as search_text
from orders o
left join partners p     on p.id = o.partner_id
left join order_items oi on oi.order_id = o.id
left join products pr    on pr.id = oi.product_id
left join order_payment_summary_view ops on ops.order_id = o.id
group by o.id, p.name, p.tax_id,
         ops.payment_status, ops.paid_amount, ops.outstanding_amount;

-- ============================================
-- 收款搜尋 View
-- order_ids 供「從單據點付款狀態跳來」時用 contains 過濾。
-- order_nos 併進 search_text，讓使用者直接搜單號也能找到對應收款。
-- ============================================
create or replace view payment_search_view as
select
  pay.id,
  pay.payment_no,
  pay.partner_id,
  pt.name       as partner_name,
  pt.partner_no,
  pay.payment_date,
  pay.amount,
  pay.method,
  pay.note,
  pay.created_at,
  coalesce(alloc.allocated_amount, 0)::numeric(12,2) as allocated_amount,
  (pay.amount - coalesce(alloc.allocated_amount, 0))::numeric(12,2) as unallocated_amount,
  coalesce(alloc.order_ids, array[]::uuid[]) as order_ids,
  coalesce(alloc.order_nos, '') as order_nos,
  pay.payment_no
    || ' ' || coalesce(pt.name, '')
    || ' ' || coalesce(pt.partner_no, '')
    || ' ' || coalesce(pay.note, '')
    || ' ' || coalesce(alloc.order_nos, '')
    as search_text
from payments pay
left join partners pt on pt.id = pay.partner_id
left join (
  select
    po.payment_id,
    sum(po.amount)::numeric(12,2) as allocated_amount,
    array_agg(po.order_id order by o.order_date, o.order_no) as order_ids,
    string_agg(o.order_no, ' ' order by o.order_date, o.order_no) as order_nos
  from payment_orders po
  join orders o on o.id = po.order_id
  group by po.payment_id
) alloc on alloc.payment_id = pay.id;

-- ============================================
-- 收款明細 View（展開某筆收款沖了哪些單、各沖多少）
-- 編輯收款時載入既有分配用。
-- ============================================
create or replace view payment_allocation_view as
select
  po.payment_id,
  po.order_id,
  o.order_no,
  o.order_date,
  po.amount as allocated_amount,
  ot.order_total
from payment_orders po
join orders o            on o.id = po.order_id
join order_total_view ot on ot.order_id = po.order_id;

-- ============================================
-- 客戶應收餘額 View：加入未分配預收
-- balance      = 出貨總額 - 累計收款（負數代表客戶有預收/溢付）
-- unallocated  = 已收但尚未指定沖哪張單的金額
-- 出貨總額改讀 order_total_view，與付款狀態的推導共用同一算式。
-- ============================================
drop view if exists partner_balance_view;

create view partner_balance_view as
with sales as (
  select partner_id, sum(order_total)::numeric(12,2) as total_sales
  from order_total_view
  where type = 'sale' and status = 'confirmed'
  group by partner_id
),
paid as (
  select partner_id, sum(amount)::numeric(12,2) as total_paid
  from payments
  group by partner_id
),
allocated as (
  select pay.partner_id, sum(po.amount)::numeric(12,2) as total_allocated
  from payment_orders po
  join payments pay on pay.id = po.payment_id
  group by pay.partner_id
)
select
  p.id, p.partner_no, p.name, p.type, p.phone,
  coalesce(s.total_sales, 0)::numeric(12,2)    as total_sales,
  coalesce(pa.total_paid, 0)::numeric(12,2)    as total_paid,
  coalesce(al.total_allocated, 0)::numeric(12,2) as total_allocated,
  (coalesce(pa.total_paid, 0) - coalesce(al.total_allocated, 0))::numeric(12,2)
    as unallocated_credit,
  (coalesce(s.total_sales, 0) - coalesce(pa.total_paid, 0))::numeric(12,2)
    as balance
from partners p
left join sales     s  on s.partner_id  = p.id
left join paid      pa on pa.partner_id = p.id
left join allocated al on al.partner_id = p.id
where p.type = 'customer';
