-- ============================================================
-- Patch 013：還原 patch-010 遺失的收款分配
-- 適用：已執行過 patch-009~012 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run，然後看最後的驗證查詢
-- ============================================================
-- 問題成因：
--   patch-010 把 audit 的 INSERT 寫成 data-modifying CTE，
--   與主語句 UPDATE 共用同一份 snapshot。audit 成功寫入、
--   UPDATE 卻未生效，導致 payment_orders.amount 停留在 NULL；
--   隨後 patch-011 的 alter column ... set not null 讓這些列無法留存。
--
--   結果：既有收款變成完全未分配的預收款，單據全部顯示未付款。
--
-- 還原依據：
--   payment_allocation_migration_audit 完整保留了 payment_id、order_id
--   與推算金額，且金額合計與收款金額相符，可精確還原，不需重新推測。
--
-- 本 patch 可重複執行：已存在的關聯不會被重複插入。
-- ============================================================

insert into payment_orders (payment_id, order_id, amount)
select a.payment_id, a.order_id, a.inferred_amount
from payment_allocation_migration_audit a
where a.inferred_amount > 0
  and exists (select 1 from payments p where p.id = a.payment_id)
  and exists (select 1 from orders   o where o.id = a.order_id)
on conflict (payment_id, order_id) do nothing;

-- ============================================
-- 驗證 1：付款狀態是否已正確推導
-- 預期：原本有沖帳的單據不再是 unpaid
-- ============================================
select
  order_no,
  order_total,
  paid_amount,
  outstanding_amount,
  payment_status
from order_payment_summary_view
order by order_date, order_no;

-- ============================================
-- 驗證 2：收款的分配情形
-- 預期：allocated_amount 等於 amount，unallocated_amount 為 0
-- ============================================
select
  payment_no,
  amount,
  allocated_amount,
  unallocated_amount,
  order_nos
from payment_search_view
order by payment_date desc;

-- ============================================
-- 驗證 3：客戶餘額
-- 預期：total_allocated 等於 total_paid，unallocated_credit 為 0
-- ============================================
select
  name,
  total_sales,
  total_paid,
  total_allocated,
  unallocated_credit,
  balance
from partner_balance_view
where total_sales <> 0 or total_paid <> 0
order by partner_no;
