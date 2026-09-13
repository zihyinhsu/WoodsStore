-- ============================================================
-- Patch 016：客戶應收餘額加入關鍵字搜尋
-- 適用：已執行過 patch-015 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 背景：
--   餘額表原本只能用客戶下拉選單篩選，一次只能指定一位。
--   關鍵字補上兩件下拉做不到的事：一次匹配多位客戶
--   （例如「建設」同時列出大同建設、永和建設），以及用統編或編號反查。
--
--   搜尋範圍刻意只含 partner_no / name / tax_id，不含收款單號或備註。
--   收款頁上方的關鍵字搜的是 payment_search_view.search_text，那是收款的欄位；
--   若餘額也套同一組關鍵字，使用者打單號時上方正確篩出收款、
--   下方餘額表卻整個空掉，因為沒有客戶叫這個單號。兩者語意不同，不可共用。
--
-- 必須先 drop 再 create：
--   create or replace function 不允許變更參數列，多一個參數會建出 overload
--   而非取代原函式，屆時 PostgREST 會因同名多載而報 function is not unique。
-- ============================================================

drop function if exists get_partner_balances(date, uuid, boolean);

-- ============================================
-- 客戶應收餘額（截至指定日期，可依客戶或關鍵字篩選）
--
-- 三個 CTE 的截止日必須一致，只截其中一側會讓 unallocated_credit 變負數。
--
-- p_partner_id 有值時只回該客戶且無條件回傳（不套 p_include_settled）：
-- 使用者明確指定了對象，即使已結清也必須看得到，否則會出現選了客戶卻空白的死路。
--
-- p_keyword 同理凌駕 p_include_settled：搜尋本身就是明確的指定意圖。
-- 若關鍵字仍受「隱藏已結清」限制，使用者打了客戶全名卻查無資料，
-- 會誤以為這位客戶不存在——這正是隱藏預設值最容易造成的認知陷阱。
--
-- p_include_settled 為 false 時濾掉餘額為 0 的客戶。條件用 <> 0 而非 > 0：
-- 負餘額代表客戶溢付、是我方負債，藏起來會漏帳；
-- unallocated_credit <> 0 也保留，那是還沒沖帳的待辦事項。
--
-- 關鍵字的 % 與 _ 是 like 的通配符，必須跳脫，否則使用者輸入 % 會匹配全部客戶。
-- 反斜線要先跳脫，順序相反會把後續補上的跳脫字元再跳脫一次。
-- ============================================
create or replace function get_partner_balances(
  p_as_of date default null,
  p_partner_id uuid default null,
  p_include_settled boolean default false,
  p_keyword text default null
) returns table (
  id uuid,
  partner_no text,
  name text,
  phone text,
  tax_id text,
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
  with params as (
    select
      nullif(btrim(coalesce(p_keyword, '')), '') as keyword
  ),
  pattern as (
    select
      case
        when pm.keyword is null then null
        else '%' || replace(replace(replace(pm.keyword, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as like_pattern
    from params pm
  ),
  sales as (
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
    p.tax_id,
    coalesce(s.total_sales, 0)::numeric(12,2),
    coalesce(pa.total_paid, 0)::numeric(12,2),
    coalesce(al.total_allocated, 0)::numeric(12,2),
    (coalesce(pa.total_paid, 0) - coalesce(al.total_allocated, 0))::numeric(12,2),
    (coalesce(s.total_sales, 0) - coalesce(pa.total_paid, 0))::numeric(12,2),
    (s.partner_id is not null or pa.partner_id is not null)
  from partners p
  cross join pattern pt
  left join sales     s  on s.partner_id  = p.id
  left join paid      pa on pa.partner_id = p.id
  left join allocated al on al.partner_id = p.id
  where p.type = 'customer'
    and (p_partner_id is null or p.id = p_partner_id)
    and (
      pt.like_pattern is null
      or p.partner_no      ilike pt.like_pattern escape '\'
      or p.name            ilike pt.like_pattern escape '\'
      or coalesce(p.tax_id, '') ilike pt.like_pattern escape '\'
    )
    and (
      p_partner_id is not null
      or pt.like_pattern is not null
      or p_include_settled
      or coalesce(s.total_sales, 0) - coalesce(pa.total_paid, 0) <> 0
      or coalesce(pa.total_paid, 0) - coalesce(al.total_allocated, 0) <> 0
    );
$$;

-- ============================================
-- 支援關鍵字比對的索引
-- ilike '%foo%' 前後都有通配符，B-tree 無法使用，需要 trigram。
-- pg_trgm 在 Supabase 為預設可用的擴充。
-- ============================================
create extension if not exists pg_trgm;

create index if not exists idx_partners_name_trgm
  on partners using gin (name gin_trgm_ops);

create index if not exists idx_partners_partner_no_trgm
  on partners using gin (partner_no gin_trgm_ops);
