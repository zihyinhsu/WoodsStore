-- patch-025-payment-top-item
-- 收款管理：主表與沖帳明細補出代表品項，讓一列就認得出收的是哪張出貨單
--
-- 背景：收款紀錄主表完全看不到出貨單（要展開才知道），展開後的明細也只有單號。
-- 單據管理已經是「商品摘要為主、單號為輔」（patch-024），收款端沿用同一套。
--
-- 代表品項的口徑（取金額最大那一項）抽成 order_top_item_view：patch-024 原本把這段
-- 寫死在 order_search_view 裡，收款端要用就得複製一份，日後改口徑會分叉。
-- order_search_view 改成 join 這個 view，欄位名稱／順序／型別皆不變，行為等價。
--
-- 沒有明細的單據不會出現在 order_top_item_view（from order_items），
-- 各處一律 left join，取不到就是 null，由前端 fallback 成只顯示單號。

-- 代表品項：金額最大的那一項。order_items 沒有 line_no 也沒有 created_at，
-- 「第一筆」本來就沒有穩定順序；金額最大者既穩定，通常也是這張單的主角。
create or replace view order_top_item_view as
select
  oi.order_id,
  count(*) as item_count,
  (array_agg(pr.name order by oi.subtotal desc nulls last))[1] as top_item_name
from order_items oi
left join products pr on pr.id = oi.product_id
group by oi.order_id;

-- item_count 仍由本 view 自己 count：這裡是 left join orders，沒有明細的單要算 0，
-- 而 order_top_item_view 根本不會有那一列。
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
  ti.top_item_name
from orders o
left join partners p     on p.id = o.partner_id
left join order_items oi on oi.order_id = o.id
left join products pr    on pr.id = oi.product_id
left join order_payment_summary_view ops on ops.order_id = o.id
left join order_top_item_view ti on ti.order_id = o.id
group by o.id, p.name, p.tax_id,
         ops.payment_status, ops.paid_amount, ops.outstanding_amount,
         ti.top_item_name;

-- 沖帳明細：每張單各自的代表品項，展開後單號欄改成雙行用。
create or replace view payment_allocation_view as
select
  po.payment_id,
  po.order_id,
  o.order_no,
  o.order_date,
  po.amount as allocated_amount,
  ot.order_total,
  ti.top_item_name,
  coalesce(ti.item_count, 0) as item_count
from payment_orders po
join orders o            on o.id = po.order_id
join order_total_view ot on ot.order_id = po.order_id
left join order_top_item_view ti on ti.order_id = po.order_id;

-- 收款主表：一筆收款可能沖多張單，列表只放得下一張，因此取「分配金額最大」的那張
-- 當代表單（與代表品項取金額最大同口徑），張數另給 order_count 讓前端組「等 N 張」。
-- amount 並列時再用日期、單號決勝，否則翻頁重查可能換一張單顯示。
-- 欄位一律追加在 search_text 之後：尾端新增才能用 create or replace，不必 drop 重建。
create or replace view payment_search_view as
select
  pay.id,
  pay.payment_no,
  pay.partner_id,
  pt.name       as partner_name,
  pt.partner_no,
  pay.payment_date,
  pay.amount,
  pay.method,
  pay.note,
  pay.created_at,
  coalesce(alloc.allocated_amount, 0)::numeric(12,2) as allocated_amount,
  (pay.amount - coalesce(alloc.allocated_amount, 0))::numeric(12,2) as unallocated_amount,
  coalesce(alloc.order_ids, array[]::uuid[]) as order_ids,
  coalesce(alloc.order_nos, '') as order_nos,
  pay.payment_no
    || ' ' || coalesce(pt.name, '')
    || ' ' || coalesce(pt.partner_no, '')
    || ' ' || coalesce(pay.note, '')
    || ' ' || coalesce(alloc.order_nos, '')
    as search_text,
  coalesce(alloc.order_count, 0) as order_count,
  alloc.top_order_no,
  alloc.top_order_date,
  alloc.top_item_name,
  coalesce(alloc.top_item_count, 0) as top_item_count
from payments pay
left join partners pt on pt.id = pay.partner_id
left join (
  select
    po.payment_id,
    sum(po.amount)::numeric(12,2) as allocated_amount,
    array_agg(po.order_id order by o.order_date, o.order_no) as order_ids,
    string_agg(o.order_no, ' ' order by o.order_date, o.order_no) as order_nos,
    count(*) as order_count,
    (array_agg(o.order_no   order by po.amount desc, o.order_date desc, o.order_no desc))[1] as top_order_no,
    (array_agg(o.order_date order by po.amount desc, o.order_date desc, o.order_no desc))[1] as top_order_date,
    (array_agg(ti.top_item_name order by po.amount desc, o.order_date desc, o.order_no desc))[1] as top_item_name,
    (array_agg(coalesce(ti.item_count, 0) order by po.amount desc, o.order_date desc, o.order_no desc))[1] as top_item_count
  from payment_orders po
  join orders o on o.id = po.order_id
  left join order_top_item_view ti on ti.order_id = po.order_id
  group by po.payment_id
) alloc on alloc.payment_id = pay.id;
