-- ============================================================
-- Patch 010：回填 payment_orders.amount
-- 適用：已執行過 patch-009 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run，然後看最後三個檢查查詢
-- ============================================================
-- 策略：
--   1. 不信任 orders.payment_status。它是人工下拉選單維護的，
--      與收款紀錄脫鉤，已知會互相矛盾，拿它當依據只會把錯誤固化。
--   2. 只從既有的 payment ↔ order 關聯推算，用保守 FIFO：
--      同一筆收款內依單據日期排序，逐張填滿，填到收款金額用完為止。
--   3. 推不出來的（收款金額不足以覆蓋關聯單據）留 NULL，寫進 audit 表，
--      由人工判斷。patch-011 加 NOT NULL 之前必須清空。
--
-- 本 patch 可重複執行：只處理 amount is null 的列。
-- ============================================================

-- ============================================
-- 回填決策稽核表
-- 保留每一列的推算依據與當時的人工付款狀態，
-- 日後對帳有疑義時可回溯這次遷移做了什麼。
-- ============================================
create table if not exists payment_allocation_migration_audit (
  id                       uuid primary key default gen_random_uuid(),
  payment_order_id         uuid not null,
  payment_id               uuid not null,
  order_id                 uuid not null,
  payment_no               text,
  order_no                 text,
  payment_amount           numeric(12,2),
  order_total              numeric(12,2),
  old_order_payment_status text,
  inferred_amount          numeric(12,2),
  reason                   text not null,
  created_at               timestamptz not null default now()
);

alter table payment_allocation_migration_audit enable row level security;

drop policy if exists "anon full access" on payment_allocation_migration_audit;
create policy "anon full access" on payment_allocation_migration_audit
  for all to anon using (true) with check (true);

-- ============================================
-- 保守 FIFO 回填
-- prior_order_total = 同一筆收款中，排在這張單之前的所有單據總額。
-- 可分配額度 = 收款金額 - 已被前面的單吃掉的額度，再與本張單總額取小。
-- ============================================
with linked as (
  select
    po.id           as payment_order_id,
    po.payment_id,
    po.order_id,
    pay.payment_no,
    pay.amount      as payment_amount,
    o.order_no,
    o.payment_status as old_order_payment_status,
    ot.order_total,
    sum(ot.order_total) over (
      partition by po.payment_id
      order by ot.order_date, ot.order_no, po.id
      rows between unbounded preceding and 1 preceding
    ) as prior_order_total
  from payment_orders po
  join payments        pay on pay.id = po.payment_id
  join orders          o   on o.id   = po.order_id
  join order_total_view ot on ot.order_id = po.order_id
  where po.amount is null
),
inferred as (
  select
    linked.*,
    greatest(
      least(order_total, payment_amount - coalesce(prior_order_total, 0)),
      0
    )::numeric(12,2) as inferred_amount
  from linked
),
audited as (
  insert into payment_allocation_migration_audit (
    payment_order_id, payment_id, order_id,
    payment_no, order_no,
    payment_amount, order_total,
    old_order_payment_status, inferred_amount, reason
  )
  select
    payment_order_id, payment_id, order_id,
    payment_no, order_no,
    payment_amount, order_total,
    old_order_payment_status, inferred_amount,
    case
      when inferred_amount >= order_total then '整張結清：收款餘額足以覆蓋單據總額'
      when inferred_amount > 0            then '部分沖帳：收款餘額不足，僅分配剩餘額度'
      else '無法推論：收款金額已被前面的單據用盡，需人工確認'
    end
  from inferred
  returning payment_order_id
)
update payment_orders po
set amount = inferred.inferred_amount
from inferred
where po.id = inferred.payment_order_id
  and inferred.inferred_amount > 0;

-- ============================================
-- 檢查 1：仍有無法推論的關聯（patch-011 前必須為空）
-- 有列出來就要人工決定：補金額、或刪掉這筆錯誤關聯。
-- ============================================
select
  a.payment_no,
  a.order_no,
  a.payment_amount,
  a.order_total,
  a.old_order_payment_status,
  a.reason
from payment_allocation_migration_audit a
join payment_orders po on po.id = a.payment_order_id
where po.amount is null
order by a.payment_no, a.order_no;

-- ============================================
-- 檢查 2：收款被超額分配（分配總額 > 收款金額）
-- 正常情況下 FIFO 不會產生這種列，若有代表原始資料已異常。
-- ============================================
select
  p.payment_no,
  p.amount                as payment_amount,
  sum(po.amount)          as allocated_amount
from payment_orders po
join payments p on p.id = po.payment_id
group by p.id, p.payment_no, p.amount
having sum(po.amount) > p.amount
order by p.payment_no;

-- ============================================
-- 檢查 3：單據被超收（分配總額 > 單據總額）
-- 多筆收款重複沖同一張單時會出現，需人工調整。
-- ============================================
select
  ot.order_no,
  ot.order_total,
  sum(po.amount) as allocated_amount
from payment_orders po
join order_total_view ot on ot.order_id = po.order_id
group by ot.order_id, ot.order_no, ot.order_total
having sum(po.amount) > ot.order_total
order by ot.order_no;

-- ============================================
-- 對照：回填後的推導狀態 vs 原本人工填的狀態
-- 這份差異清單就是「原本錯在哪裡」，建議跑完存一份再進 patch-011。
-- ============================================
select
  s.order_no,
  s.order_total,
  s.paid_amount,
  o.payment_status as manual_status,
  s.payment_status as derived_status
from order_payment_summary_view s
join orders o on o.id = s.order_id
where coalesce(o.payment_status, 'unpaid') is distinct from s.payment_status
order by s.order_date desc, s.order_no;
