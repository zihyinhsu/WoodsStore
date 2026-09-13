-- ============================================================
-- Patch 009：收款逐單分配金額 + 付款狀態改為推導
-- 適用：已執行過 migration.sql + patch-001~008 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 背景：
--   payment_orders 原本只有 (payment_id, order_id) 兩個外鍵，沒有金額，
--   因此無法計算「某張單被收了多少錢」，付款狀態只能靠人工在單據頁下拉選單維護，
--   與實際收款紀錄完全脫鉤。
--
-- 本 patch 只做「加欄位 + 建 view」，不加 NOT NULL、不加 trigger，
-- 讓既有資料能先被 patch-010 回填。約束在 patch-011 才收緊。
-- ============================================================

-- ============================================
-- payment_orders 加上逐單分配金額
-- 暫時允許 NULL：既有資料由 patch-010 回填後才收緊
-- ============================================
alter table payment_orders
  add column if not exists amount numeric(12,2);

comment on column payment_orders.amount is
  '此筆收款分配到該張出貨單的金額。單一事實來源，付款狀態由此推導。';

-- ============================================
-- 單據金額 View（抽出重複的總額算式）
-- 原本 partner_balance_view 與 unpaid_order_view 各自重算一次，
-- 收斂成單一定義避免兩邊算法漂移。
-- discount / tax 可能為 null，一律 coalesce，否則整張單總額會變 null。
-- ============================================
create or replace view order_total_view as
select
  o.id as order_id,
  o.partner_id,
  o.order_no,
  o.order_date,
  o.type,
  o.status,
  (coalesce(items.item_total, 0)
    - coalesce(o.discount, 0)
    + coalesce(o.tax, 0))::numeric(12,2) as order_total
from orders o
left join (
  select order_id, sum(subtotal)::numeric(12,2) as item_total
  from order_items
  group by order_id
) items on items.order_id = o.id;

-- ============================================
-- 單據收款彙總 View（付款狀態的唯一推導來源）
-- 只涵蓋已確認的出貨單：進貨/調整/草稿/作廢單不談應收。
-- ============================================
create or replace view order_payment_summary_view as
select
  ot.order_id,
  ot.partner_id,
  ot.order_no,
  ot.order_date,
  ot.order_total,
  coalesce(sum(po.amount), 0)::numeric(12,2) as paid_amount,
  greatest(ot.order_total - coalesce(sum(po.amount), 0), 0)::numeric(12,2) as outstanding_amount,
  case
    when coalesce(sum(po.amount), 0) <= 0            then 'unpaid'
    when coalesce(sum(po.amount), 0) < ot.order_total then 'partial'
    else 'paid'
  end as payment_status
from order_total_view ot
left join payment_orders po on po.order_id = ot.order_id
where ot.type = 'sale'
  and ot.status = 'confirmed'
group by
  ot.order_id, ot.partner_id, ot.order_no, ot.order_date, ot.order_total;

-- ============================================
-- 未收清單 View（取代 unpaid_order_view）
-- 舊版用 not exists 判定，一張單只要收過 1 元就從清單消失，
-- 導致部分收款的單再也收不到第二筆。改用 outstanding_amount > 0 判定。
-- ============================================
create or replace view outstanding_order_view as
select
  s.order_id as id,
  s.partner_id,
  s.order_no,
  s.order_date,
  s.order_total,
  s.paid_amount,
  s.outstanding_amount,
  s.payment_status
from order_payment_summary_view s
where s.outstanding_amount > 0;

-- ============================================
-- 相容層：舊前端仍在查 unpaid_order_view
-- 欄位名 order_total 對齊舊版，前端切換完成後可移除。
-- ============================================
drop view if exists unpaid_order_view;

create view unpaid_order_view as
select
  id,
  partner_id,
  order_no,
  order_date,
  outstanding_amount as order_total
from outstanding_order_view;
