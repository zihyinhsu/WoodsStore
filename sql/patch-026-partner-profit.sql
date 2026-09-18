-- patch-026-partner-profit
-- 客戶毛利：總覽頁能回答「在哪個客戶身上賺了多少」
--
-- 背景：系統原本只算得出「哪個商品賺錢」（product_cost_analysis / cost_ranking），
-- 客戶維度完全空白——往來對象只有名冊欄位，應收餘額只講「還沒收多少」，
-- 都不講「這筆生意賺不賺」。算客戶毛利所需的資料其實都在：出貨成本快照
-- （order_items.unit_cost，patch-018）逐筆寫定，整單折讓分攤（patch-021）也已存在，
-- 缺的只是「按客戶」這個聚合維度。
--
-- 依賴 patch-021（order_discount_alloc），務必排在其後；照檔名順序貼上即可。
--
-- 口徑（與總覽、商品頁完全一致，刻意不自創第二套）：
--   收益 = Σ(明細小計 − 分攤的整單折讓)，未稅
--   成本 = Σ(出貨明細 unit_cost × 數量)，成本快照，不隨查詢區間漂移
--   毛利 = 收益 − 成本。稅是代收代付、不是收入，不計入毛利
--   範圍 = type='sale' 且 status='confirmed'（product_movement_base 已內含此條件）
--
-- 兩個必須知道的失真來源，都以欄位回報給前端而非默默吞掉：
--   1. unit_cost 為 null（早期無進貨基礎的出貨）以 0 計入成本 → 毛利會高估。
--      因此回傳 no_cost_qty，讓前端在該列標記提醒。
--   2. partner_id 為 null 的出貨單不列入任何客戶 → 客戶毛利合計會小於
--      product_cost_analysis_summary 的同期毛利，差額就是這些無客戶單據。

-- ----------------------------------------
-- 進出貨明細基底：尾端追加 partner_id 與 order_id
-- 複用這支既有 view 而不新建一份，是為了沿用同一段折讓分攤算式，不讓口徑分叉。
-- 新欄一律追加在最後：create or replace view 不允許改動既有欄的名稱與位置
-- （會報 cannot change name of view column），插在中間就得 drop 重建。
-- ----------------------------------------
create or replace view product_movement_base as
select
  oi.product_id,
  o.order_date,
  o.type,
  abs(oi.qty) as qty,
  oi.subtotal,
  oi.unit_cost,
  -- 整單折讓掛在單、不掛在商品，按明細小計比例分攤到本列，毛利才不會因忽略折讓而高估。
  -- 保持全精度不 round：同一單各列分攤和恆等於整單折讓，合計不會因逐列進位而漂移。
  -- 整單小計為 0 卻有折讓的異常單以 nullif 防除零，該情況不分攤。
  o.discount * oi.subtotal
    / nullif(sum(oi.subtotal) over (partition by oi.order_id), 0) as order_discount_alloc,
  -- patch-026 追加：客戶毛利要按客戶聚合、並算得出「這客戶期間內出了幾張單」。
  o.partner_id,
  o.id as order_id
from orders o
join order_items oi on oi.order_id = o.id
where o.status = 'confirmed'
  and o.type in ('purchase', 'sale');

-- ----------------------------------------
-- 先 drop 再建：這支 patch 在開發期間調整過回傳欄位與參數，而 create or replace function
-- 不允許改動回傳型別（報 cannot change return type of existing function）也不允許改參數名，
-- 那一條 statement 會直接失敗、舊版函式原封不動留著，前端就會拿到少了欄位的結果
-- （實際症狀：排行圖 tooltip 的出貨額／成本／單數全是 0，只有毛利對）。
-- 改參數個數更糟：不會報錯，而是多出一個同名的重載，內部呼叫會變成 ambiguous。
-- 一律先 drop 才能保證「重跑整支檔案」的結果與初次套用一致。第一次套用時 if exists 不會有事。
-- 依存關係：本檔的函式是字串函式體（$$...$$），Postgres 不追蹤彼此依賴，
-- 因此 drop 的順序無所謂，只要下方 create 的順序是先 partner_profit 再其餘三支即可。
-- ----------------------------------------
drop function if exists partner_profit(date, date, text, uuid);
drop function if exists partner_profit(date, date, text);          -- 開發期間的 3 參數版
drop function if exists partner_profit_ranking(date, date, int, text);
drop function if exists partner_profit_ranking(date, date, int);   -- 開發期間的無關鍵字版
drop function if exists partner_profit_summary(date, date, text);
drop function if exists partner_profit_products(uuid, date, date);

-- ----------------------------------------
-- 逐客戶毛利（一客戶一列；排序與分頁交給前端 .order()/.range()，同 product_cost_analysis）
-- 只回期間內有出貨的客戶：沒出貨就沒有毛利可談，列出來只是一堆 0。
-- p_from / p_to 允許 null（＝累計不限該側），比照 product_cost_detail_summary。
-- p_partner_id 指定時只回那一位客戶——modal 要「單一客戶 × 自訂區間」的彙總，
-- 走這裡才與清單同一套算式，不必在前端另湊一份數字（同 get_partner_balances 的做法）。
-- ----------------------------------------
create or replace function partner_profit(
  p_from date default null,
  p_to date default null,
  p_keyword text default null,
  p_partner_id uuid default null
) returns table (
  partner_id uuid,
  partner_no text,
  name text,
  sale_amount numeric,
  cost numeric,
  profit numeric,
  order_count bigint,
  last_sale_date date,
  no_cost_qty bigint
)
language sql
stable
security invoker
as $$
  with params as (
    select nullif(btrim(coalesce(p_keyword, '')), '') as keyword
  ),
  pattern as (
    -- % 與 _ 是 like 通配符必須跳脫，否則使用者輸入 % 會匹配全部客戶。
    -- 反斜線要先跳脫，順序相反會把後續補上的跳脫字元再跳脫一次。
    -- 與 get_partner_balances 同一段寫法，勿各寫一份。
    select
      case
        when pm.keyword is null then null
        else '%' || replace(replace(replace(pm.keyword, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as like_pattern
    from params pm
  ),
  agg as (
    select
      m.partner_id,
      sum(m.subtotal - coalesce(m.order_discount_alloc, 0))::numeric(12,2) as sale_amount,
      sum(coalesce(m.unit_cost, 0) * m.qty)::numeric(12,2)                 as cost,
      count(distinct m.order_id)                                           as order_count,
      max(m.order_date)                                                    as last_sale_date,
      -- 成本未知的出貨量：unit_cost 為 null 時上面以 0 計入，毛利會高估，
      -- 這個數字就是「高估了多少件的成本」，讓前端有依據標記提醒。
      coalesce(sum(m.qty) filter (where m.unit_cost is null), 0)           as no_cost_qty
    from product_movement_base m
    where m.type = 'sale'
      and m.partner_id is not null
      and (p_partner_id is null or m.partner_id = p_partner_id)
      and (p_from is null or m.order_date >= p_from)
      and (p_to   is null or m.order_date <= p_to)
    group by m.partner_id
  )
  select
    p.id,
    p.partner_no,
    p.name,
    a.sale_amount,
    a.cost,
    (a.sale_amount - a.cost)::numeric(12,2),
    a.order_count,
    a.last_sale_date,
    a.no_cost_qty
  from agg a
  join partners p on p.id = a.partner_id and p.type = 'customer'
  cross join pattern pt
  where pt.like_pattern is null
    or p.partner_no           ilike pt.like_pattern escape '\'
    or p.name                 ilike pt.like_pattern escape '\'
    or coalesce(p.tax_id, '') ilike pt.like_pattern escape '\';
$$;

-- ----------------------------------------
-- 客戶毛利排行（總覽左側橫條圖）：頭尾各 p_limit 名，union 去重、由高到低
-- 結構照 cost_ranking，讓兩張排行圖行為一致（含並列時用編號決勝）。
-- 帶 p_keyword：圖與右側表格吃同一組篩選，否則搜尋後兩邊講的是不同客戶群。
--
-- 除了 profit 還回出貨額／成本／單數：長條只畫得出毛利一個維度，滑過去的 tooltip
-- 卻該回答「這條為什麼這麼長」——毛利 6 萬是做 18 萬的生意省下來的，還是做 60 萬
-- 只賺這些，看的人要當場分得出來，否則得再去右邊表格找同一位客戶。
-- ----------------------------------------
create or replace function partner_profit_ranking(
  p_from date default null,
  p_to date default null,
  p_limit int default 5,
  p_keyword text default null
) returns table (
  partner_id uuid,
  partner_no text,
  name text,
  profit numeric,
  sale_amount numeric,
  cost numeric,
  order_count bigint
)
language sql
stable
security invoker
as $$
  with ranked as (
    select pp.partner_id, pp.partner_no, pp.name, pp.profit,
           pp.sale_amount, pp.cost, pp.order_count
    from partner_profit(p_from, p_to, p_keyword) pp
  )
  select * from (
    (select * from ranked order by profit desc, partner_no asc limit p_limit)
    union
    (select * from ranked order by profit asc,  partner_no asc limit p_limit)
  ) top_bottom
  order by profit desc, partner_no asc;
$$;

-- ----------------------------------------
-- 客戶毛利的期間合計（總覽上方的合計列）
-- 直接對 partner_profit 加總，而非另寫一段聚合：卡片數字與清單合計因此恆等，
-- 不會出現「上面說 13 萬、下面加起來 12.8 萬」這種無從判斷哪個才算數的情況
-- （同 product_cost_analysis_summary 的理由）。
-- ----------------------------------------
create or replace function partner_profit_summary(
  p_from date default null,
  p_to date default null,
  p_keyword text default null
) returns table (
  sale_amount numeric,
  cost numeric,
  profit numeric,
  customer_count bigint
)
language sql
stable
security invoker
as $$
  select
    coalesce(sum(pp.sale_amount), 0)::numeric(12,2),
    coalesce(sum(pp.cost), 0)::numeric(12,2),
    coalesce(sum(pp.profit), 0)::numeric(12,2),
    count(*)
  from partner_profit(p_from, p_to, p_keyword) pp;
$$;

-- ----------------------------------------
-- 單一客戶的商品組成（點列後 modal 的明細；前端分頁）
-- 回答「在這個客戶身上是靠什麼賺的」，也看得出哪些品項在這客戶身上是賠的。
-- 單據層級的查帳有對帳單與單據管理，這裡刻意只做商品維度。
-- ----------------------------------------
create or replace function partner_profit_products(
  p_partner_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  product_id uuid,
  sku text,
  name text,
  unit text,
  sale_qty bigint,
  sale_amount numeric,
  cost numeric,
  profit numeric
)
language sql
stable
security invoker
as $$
  select
    pr.id,
    pr.sku,
    pr.name,
    pr.unit,
    sum(m.qty)::bigint,
    sum(m.subtotal - coalesce(m.order_discount_alloc, 0))::numeric(12,2),
    sum(coalesce(m.unit_cost, 0) * m.qty)::numeric(12,2),
    (sum(m.subtotal - coalesce(m.order_discount_alloc, 0))
      - sum(coalesce(m.unit_cost, 0) * m.qty))::numeric(12,2)
  from product_movement_base m
  join products pr on pr.id = m.product_id
  where m.type = 'sale'
    and m.partner_id = p_partner_id
    and (p_from is null or m.order_date >= p_from)
    and (p_to   is null or m.order_date <= p_to)
  group by pr.id, pr.sku, pr.name, pr.unit;
$$;
