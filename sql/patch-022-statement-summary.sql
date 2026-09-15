-- patch-022-statement-summary
-- 對帳單資料量重構：左欄彙總改由後端聚合
--
-- 背景：對帳單頁原本一次撈出日期區間內「所有客戶」的出貨明細與收款，前端 groupBy
-- 逐客戶加總算餘額，再把整份明細全量渲染。區間拉大（跨年）時明細筆數會全部灌進瀏覽器。
--
-- 本 patch 新增 statement_summary：一次回傳期間內有出貨或收款的客戶及其彙總
-- （期前餘額／本期應收／本期已收／合計應收），前端不必再拉任何明細即可畫左欄與合計。
-- 右欄明細改由前端切到該客戶時才查 statement_line_view（不在本 patch）。
--
-- 口徑：金額取 statement_line_view.subtotal（明細小計、不含整單折讓與稅），與明細頁一致，
-- 刻意與 partner_balance_view 的 order_total（含折讓、含稅）不同。schema.sql 已同步更新。

create or replace function statement_summary(
  p_from date,
  p_to date
) returns table (
  id uuid,
  partner_no text,
  name text,
  tax_id text,
  phone text,
  address text,
  prev_balance numeric,
  prev_paid numeric,
  current_sales numeric,
  current_paid numeric,
  total_balance numeric
)
language sql
stable
security invoker
as $$
  with cur_sales as (
    select partner_id, sum(subtotal)::numeric(12,2) as amount
    from statement_line_view
    where order_date between p_from and p_to
    group by partner_id
  ),
  cur_paid as (
    select partner_id, sum(amount)::numeric(12,2) as amount
    from payments
    where payment_date between p_from and p_to
    group by partner_id
  ),
  prev_sales as (
    select partner_id, sum(subtotal)::numeric(12,2) as amount
    from statement_line_view
    where order_date < p_from
    group by partner_id
  ),
  prev_paid as (
    select partner_id, sum(amount)::numeric(12,2) as amount
    from payments
    where payment_date < p_from
    group by partner_id
  ),
  -- 期間內有出貨或有收款者才算「有對帳單」；期前有往來但本期無異動的不列入。
  active as (
    select partner_id from cur_sales
    union
    select partner_id from cur_paid
  )
  select
    p.id,
    p.partner_no,
    p.name,
    p.tax_id,
    p.phone,
    p.address,
    (coalesce(ps.amount, 0) - coalesce(pp.amount, 0))::numeric(12,2),
    coalesce(pp.amount, 0)::numeric(12,2),
    coalesce(cs.amount, 0)::numeric(12,2),
    coalesce(cp.amount, 0)::numeric(12,2),
    (coalesce(ps.amount, 0) - coalesce(pp.amount, 0)
       + coalesce(cs.amount, 0) - coalesce(cp.amount, 0))::numeric(12,2)
  from active a
  join partners p on p.id = a.partner_id
  left join cur_sales  cs on cs.partner_id = p.id
  left join cur_paid   cp on cp.partner_id = p.id
  left join prev_sales ps on ps.partner_id = p.id
  left join prev_paid  pp on pp.partner_id = p.id;
$$;
