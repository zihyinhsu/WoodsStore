-- patch-024-order-top-item
-- 單據列表：view 補出代表品項，讓一列就認得出這張單裝了什麼
--
-- 背景：單據管理列表只顯示單號，光看 SO-20260918-001 認不出內容。列表改為
-- 單號欄雙行（單號 + 商品摘要），摘要需要一個代表品項。
--
-- 代表品項取「金額最大的那一項」：order_items 沒有 line_no 也沒有 created_at，
-- 「第一筆」本來就沒有穩定順序；金額最大者既穩定，通常也是這張單的主角。
-- 單據沒有明細時為 null（left join），由前端 fallback。
--
-- 「等 N 項」的文案不放這裡：項數用既有的 item_count，字串由前端組，
-- 避免中文 UI 文案寫死在 view 裡。
--
-- 欄位加在 search_text 之後，尾端新增才能用 create or replace（不必 drop 重建）。
-- schema.sql 已同步更新。
--
-- 注意：feat/expected-payment-reminder 分支也重寫了這個 view（加 expected_payment_date、
-- reminder_event_id），兩邊合併時需手動併成同一份定義。

create or replace view order_search_view as
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
    as search_text,
  (array_agg(pr.name order by oi.subtotal desc nulls last))[1] as top_item_name
from orders o
left join partners p     on p.id = o.partner_id
left join order_items oi on oi.order_id = o.id
left join products pr    on pr.id = oi.product_id
left join order_payment_summary_view ops on ops.order_id = o.id
group by o.id, p.name, p.tax_id,
         ops.payment_status, ops.paid_amount, ops.outstanding_amount;
