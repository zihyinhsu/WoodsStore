-- ============================================================
-- Patch 015：客戶應收餘額改為可指定截止日 + 可篩選 + 可分頁
-- 適用：已執行過 patch-014 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 背景：
--   收款頁的應收餘額原本直接查 partner_balance_view，那是「全期間累計」，
--   不吃任何日期，且一次回傳全部客戶。客戶數變多後整張表會把版面拉長，
--   也無法回答「某個日期當下這位客戶欠多少」。
--
-- 本 patch 提供 as-of 版本：截止日之前發生的出貨與收款才計入。
-- 口徑刻意選「期末快照」而非「期間發生額」：
--   若只算區間內的出貨減收款，一位三個月沒下單但積欠 50 萬的客戶
--   餘額會顯示 0，而他正是最該被追的人。
--
-- 不做 limit/offset 參數：與 product_cost_movements 一致，
-- 回傳全集由前端用 { count: 'exact' } + .range() 分頁，
-- 這樣才拿得到總筆數渲染頁碼。
-- ============================================================

-- ============================================
-- 客戶應收餘額（截至指定日期）
--
-- total_sales / total_paid / total_allocated 三者必須套用同一個截止日。
-- 只截其中一側會算出荒謬的結果：例如收款截止、分配不截，
-- unallocated_credit（已收 − 已分配）會變成負數。
--
-- p_as_of 為 null 代表不限截止日，等同原本 partner_balance_view 的全期間口徑。
--
-- p_partner_id 有值時只回該客戶，且無條件回傳（不套用 p_include_settled）。
-- 這是刻意的：使用者從下拉選單明確指定了對象，即使他已結清也必須看得到，
-- 否則會出現「選了客戶卻整張表空白」的死路。
--
-- p_include_settled 為 false 時濾掉餘額為 0 的客戶。條件用 balance <> 0
-- 而非 balance > 0：負餘額代表客戶溢付、是我方負債，藏起來會漏帳。
-- unallocated_credit <> 0 也一併保留，那是還沒沖帳的待辦事項。
--
-- 從未往來的客戶（建了檔但沒出貨也沒收款）不屬於「已結清」，
-- 以 has_activity 分流，避免把他們混進結清數字裡失真。
-- ============================================
create or replace function get_partner_balances(
  p_as_of date default null,
  p_partner_id uuid default null,
  p_include_settled boolean default false
) returns table (
  id uuid,
  partner_no text,
  name text,
  phone text,
  total_sales numeric,
  total_paid numeric,
  total_allocated numeric,
  unallocated_credit numeric,
  balance numeric,
  has_activity boolean
)
language sql
stable
security invoker
as $$
  with sales as (
    select ot.partner_id, sum(ot.order_total)::numeric(12,2) as total_sales
    from order_total_view ot
    where ot.type = 'sale'
      and ot.status = 'confirmed'
      and (p_as_of is null or ot.order_date <= p_as_of)
    group by ot.partner_id
  ),
  paid as (
    select pay.partner_id, sum(pay.amount)::numeric(12,2) as total_paid
    from payments pay
    where p_as_of is null or pay.payment_date <= p_as_of
    group by pay.partner_id
  ),
  allocated as (
    select pay.partner_id, sum(po.amount)::numeric(12,2) as total_allocated
    from payment_orders po
    join payments pay on pay.id = po.payment_id
    where p_as_of is null or pay.payment_date <= p_as_of
    group by pay.partner_id
  )
  select
    p.id,
    p.partner_no,
    p.name,
    p.phone,
    coalesce(s.total_sales, 0)::numeric(12,2),
    coalesce(pa.total_paid, 0)::numeric(12,2),
    coalesce(al.total_allocated, 0)::numeric(12,2),
    (coalesce(pa.total_paid, 0) - coalesce(al.total_allocated, 0))::numeric(12,2),
    (coalesce(s.total_sales, 0) - coalesce(pa.total_paid, 0))::numeric(12,2),
    (s.partner_id is not null or pa.partner_id is not null)
  from partners p
  left join sales     s  on s.partner_id  = p.id
  left join paid      pa on pa.partner_id = p.id
  left join allocated al on al.partner_id = p.id
  where p.type = 'customer'
    and (p_partner_id is null or p.id = p_partner_id)
    and (
      p_partner_id is not null
      or p_include_settled
      or coalesce(s.total_sales, 0) - coalesce(pa.total_paid, 0) <> 0
      or coalesce(pa.total_paid, 0) - coalesce(al.total_allocated, 0) <> 0
    );
$$;

-- ============================================
-- 支援上述查詢的索引
-- 三個 CTE 都以日期截止再依 partner_id 聚合。
-- payments 目前只有 partner_id 的索引，截止日條件掃不到。
-- ============================================
create index if not exists idx_payments_date_partner
  on payments (payment_date, partner_id);
