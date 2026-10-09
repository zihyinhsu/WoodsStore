-- patch-029-order-groups
-- 進出貨管理以「組」為單位列出：接續同一張原單的分批單據合併成一列
--
-- 背景：patch-028 讓分批到貨的單以 parent_order_id 接續原單，但列表仍一張一列，
-- 使用者要同一批貨只看到一列、展開才逐批列出。
--
-- 為什麼寫成 RPC 而不在前端把接續單藏起來：列表是伺服器端分頁，前端藏列會讓每頁張數
-- 與總頁數錯亂；更嚴重的是篩選會整組漏掉——10 月的日期區間只命中 10 月到的 B，
-- 9 月開的 A 被日期濾掉、B 又被藏起來，整組就消失了。必須以組為單位篩選、計數與分頁。
--
-- 整份可重複執行（create or replace，簽名未變動前不需 drop）。

-- ----------------------------------------
-- 依組搜尋單據（分批進出貨的合併列表）
-- 各篩選條件套用的層級不同，刻意如此：
--   - 狀態、類型：成員層級，決定組裡「有哪些單」。張數、合計只算通過的成員，
--     預設「有效」時作廢的那批不算進合計，展開也看不到。
--   - 日期、關鍵字：組內任一批命中就整組列出。分批常跨月，搜 B 才有的商品也要找得到這組。
--   - 付款狀態：套在組推導後的狀態。篩「未結清」是要找整批還欠多少，
--     A 已付、B 未付的組是「部分付款」，必須被列入；逐張比對會讓結果與列上顯示的狀態不一致。
-- 組付款狀態：組內沒有已確認的進出貨單 → null；一毛未付 → unpaid；未付為 0 → paid；其餘 partial。
-- total_count 用 window function 在 limit 之前計算，給前端算總頁數。
-- ----------------------------------------
create or replace function search_order_groups(
  p_date_from date default null,
  p_date_to   date default null,
  p_type      text default null,
  p_statuses  text[] default null,
  p_payment   text default null,
  p_keyword   text default null,
  p_limit     int default 20,
  p_offset    int default 0
) returns table (
  group_root_id      uuid,
  group_root_no      text,
  type               text,
  partner_id         uuid,
  partner_name       text,
  order_date         date,
  latest_created_at  timestamptz,
  batch_count        bigint,
  member_ids         uuid[],
  total_amount       numeric,
  paid_amount        numeric,
  outstanding_amount numeric,
  payment_status     text,
  total_count        bigint
)
language sql
stable
security invoker
as $$
  with members as (
    select s.*
    from order_search_view s
    where (p_statuses is null or s.status = any(p_statuses))
      and (p_type is null or s.type = p_type)
  ),
  hit as (
    select distinct m.group_root_id
    from members m
    where (p_date_from is null or m.order_date >= p_date_from)
      and (p_date_to   is null or m.order_date <= p_date_to)
      and (coalesce(p_keyword, '') = '' or m.search_text ilike '%' || p_keyword || '%')
  ),
  groups as (
    select
      m.group_root_id,
      min(m.group_root_no) as group_root_no,
      min(m.type) as type,
      -- 同組必同對象（guard_order_parent），取第一個即可；uuid 沒有 min()。
      (array_agg(m.partner_id))[1] as partner_id,
      min(m.partner_name) as partner_name,
      max(m.order_date) as order_date,
      max(m.created_at) as latest_created_at,
      count(*) as batch_count,
      array_agg(m.id order by m.order_date, m.created_at) as member_ids,
      sum(m.total_amount)::numeric(12,2) as total_amount,
      -- 只有已確認的進出貨單有付款狀態（order_search_view 其餘給 null），草稿不談收付。
      coalesce(sum(coalesce(m.paid_amount, 0))
        filter (where m.payment_status is not null), 0)::numeric(12,2) as paid_amount,
      coalesce(sum(coalesce(m.outstanding_amount, m.total_amount))
        filter (where m.payment_status is not null), 0)::numeric(12,2) as outstanding_amount,
      bool_or(m.payment_status is not null) as payable
    from members m
    join hit h on h.group_root_id = m.group_root_id
    group by m.group_root_id
  ),
  derived as (
    select
      g.*,
      case
        when not g.payable              then null
        when g.paid_amount <= 0         then 'unpaid'
        when g.outstanding_amount <= 0  then 'paid'
        else 'partial'
      end as payment_status
    from groups g
  )
  select
    d.group_root_id, d.group_root_no, d.type, d.partner_id, d.partner_name,
    d.order_date, d.latest_created_at, d.batch_count, d.member_ids,
    d.total_amount, d.paid_amount, d.outstanding_amount, d.payment_status,
    count(*) over () as total_count
  from derived d
  where p_payment is null
     or (p_payment = 'outstanding' and d.payment_status in ('unpaid', 'partial'))
     or d.payment_status = p_payment
  order by d.order_date desc, d.latest_created_at desc, d.group_root_id
  limit p_limit offset p_offset;
$$;
