-- patch-033-supplier-purchase-items-keyword
-- 供應商進貨 modal 的明細加上關鍵字搜尋（單號／品名／商品編號）。
--
-- 動 SQL 前必須知道的事：
--   - 明細是分頁取回的，只能在 SQL 端篩：前端只拿得到當頁，篩不到其他頁的列。
--   - 改參數簽章要先 drop 舊的三參數版本：create or replace 遇到不同簽章會另建一個重載，
--     PostgREST 收到只帶三個參數的呼叫時會因為兩個候選而回 300 Multiple Choices。
--   - 關鍵字只篩明細，不影響上方卡片（supplier_purchase）：卡片回答的是「這段期間跟這家買了多少」，
--     搜尋是在那份明細裡找東西，兩者口徑不同。
--
-- 整份在一個交易內，可重複執行。

begin;

drop function if exists supplier_purchase_items(uuid, date, date);

-- 單一供應商的進貨明細（modal 下方；前端分頁）
-- amount 是本列扣掉分攤整單折讓後的金額，與上方彙總同一口徑；
-- 逐列進位到分，整單有折讓時各列加總可能與彙總差一兩分，彙總以 supplier_purchase 為準。
-- 排序在前端指定（function inline 後內部 ORDER BY 不保證留存，見 product_cost_movements）。
create or replace function supplier_purchase_items(
  p_partner_id uuid,
  p_from date default null,
  p_to date default null,
  p_keyword text default null
) returns table (
  item_id uuid,
  order_no text,
  order_date date,
  type text,
  product_id uuid,
  sku text,
  name text,
  unit text,
  qty numeric,
  unit_price numeric,
  amount numeric
)
language sql
stable
security invoker
as $$
  with params as (
    select nullif(btrim(coalesce(p_keyword, '')), '') as keyword
  ),
  pattern as (
    -- 與 supplier_purchase、partner_profit 同一段跳脫寫法。
    select
      case
        when pm.keyword is null then null
        else '%' || replace(replace(replace(pm.keyword, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as like_pattern
    from params pm
  )
  select
    m.item_id,
    o.order_no,
    m.order_date,
    m.type,
    pr.id,
    pr.sku,
    pr.name,
    pr.unit,
    m.qty,
    oi.unit_price,
    (m.subtotal - coalesce(m.order_discount_alloc, 0))::numeric(12,2)
  from product_movement_base m
  join orders o       on o.id = m.order_id
  join order_items oi on oi.id = m.item_id
  join products pr    on pr.id = m.product_id
  cross join pattern pt
  where m.flow = 'purchase'
    and m.partner_id = p_partner_id
    and (p_from is null or m.order_date >= p_from)
    and (p_to   is null or m.order_date <= p_to)
    and (
      pt.like_pattern is null
      or o.order_no              ilike pt.like_pattern escape '\'
      or pr.name                 ilike pt.like_pattern escape '\'
      or coalesce(pr.sku, '')    ilike pt.like_pattern escape '\'
    );
$$;

revoke execute on function supplier_purchase_items(uuid, date, date, text) from public, anon;
grant  execute on function supplier_purchase_items(uuid, date, date, text) to authenticated;

-- 讓 PostgREST 立即重讀 schema，否則前端在快取過期前呼叫新簽章會拿到 404。
notify pgrst, 'reload schema';

commit;
