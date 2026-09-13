-- ============================================================
-- Patch 004：移除商品條碼欄位
-- 適用：已執行過 migration.sql + patch-001~003 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 注意：stock_view 與 order_search_view 都引用了 products.barcode，
-- 必須先移除這兩個 view 才能刪除欄位，最後再重建。

drop view if exists order_search_view;
drop view if exists stock_view;

alter table products drop column if exists barcode;

-- ============================================
-- 即時庫存 View（只計已確認單據）
-- ============================================
create view stock_view as
select p.id, p.sku, p.name, p.spec, p.category, p.unit,
       p.cost, p.price, p.tax_type, p.safety_stock, p.location,
       p.image_url, p.is_active, p.created_at,
       coalesce(sum(oi.qty) filter (where o.status = 'confirmed'), 0) as stock_qty
from products p
left join order_items oi on oi.product_id = p.id
left join orders o       on o.id = oi.order_id
group by p.id;

-- ============================================
-- 單據搜尋 View（時間區間 + 關鍵字）
-- ============================================
create view order_search_view as
select
  o.id, o.order_no, o.type, o.status, o.order_date,
  o.discount, o.tax, o.payment_status, o.note, o.created_at,
  o.partner_id,
  p.name as partner_name,
  count(oi.id)     as item_count,
  coalesce(sum(oi.subtotal), 0) as total_amount,
  o.order_no || ' ' || coalesce(o.note,'')
    || ' ' || coalesce(p.name,'') || ' ' || coalesce(p.tax_id,'')
    || ' ' || coalesce(string_agg(
         pr.name || ' ' || pr.sku, ' '), '')
    as search_text
from orders o
left join partners p     on p.id = o.partner_id
left join order_items oi on oi.order_id = o.id
left join products pr    on pr.id = oi.product_id
group by o.id, p.name, p.tax_id;
