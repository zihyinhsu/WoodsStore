-- ============================================================
-- patch-014：單一商品的進出貨成本分析（聚合 + 可分頁明細）
--
-- 原本商品頁的成本分析是把該商品期間內所有 order_items 全撈回瀏覽器，
-- 在前端加總算均價、再 slice(0, 50) 只顯示前 50 筆，其餘資料撈了就丟。
-- 交易筆數上千的熱門商品，等於每開一次 modal 就搬一次全表。
--
-- 改成：聚合交給 product_cost_detail_summary（掃全期間但只回一列），
-- 明細交給 product_cost_movements（前端以 range 分頁，一次只回一頁）。
-- 與 patch-008 的原則一致：聚合在資料庫做，前端只拿彙總結果並分頁。
--
-- p_from / p_to 可為 null，代表該側不限日期（對應 modal 的「累計」快捷鍵）。
-- ============================================================

-- ============================================
-- 單一商品的期間彙總
--
-- 口徑必須與原本前端的算法逐項對齊，否則改版後數字會跳動：
--   進出貨量 = Σ abs(qty)（銷貨的 qty 存負數，進貨存正數）
--   金額     = Σ subtotal（generated column，已含明細折扣）
-- 調整單（type = 'adjust'）不列入任何一側：它只是庫存校正，
-- 沒有真實的進價或售價，混進均價會把成本算歪。
--
-- 進貨側的 abs() 只在「合法資料」下與舊版前端的 Σ qty 等價：create_order() 會
-- 強制非調整單的數量大於 0，進貨再乘上正號寫入。若有人繞過 RPC 直接塞一筆
-- 負數的進貨明細，這裡會取絕對值、舊版則會倒扣，兩者才會出現差異。
-- ============================================
create or replace function product_cost_detail_summary(
  p_product_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric
)
language sql
stable
security invoker
as $$
  select
    coalesce(sum(abs(oi.qty)) filter (where o.type = 'purchase'), 0),
    coalesce(sum(oi.subtotal) filter (where o.type = 'purchase'), 0),
    coalesce(sum(abs(oi.qty)) filter (where o.type = 'sale'), 0),
    coalesce(sum(oi.subtotal) filter (where o.type = 'sale'), 0)
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.product_id = p_product_id
    and o.status = 'confirmed'
    and (p_from is null or o.order_date >= p_from)
    and (p_to   is null or o.order_date <= p_to);
$$;

-- ============================================
-- 單一商品的期間進出明細（供前端分頁）
--
-- 這裡「不」過濾 type：調整單也要出現在明細表上，讓使用者看得到庫存被校正過，
-- 只是上面的彙總不把它算進均價。這個差異是刻意的，改動時請一併確認兩支函式。
--
-- item_id 一定要輸出：前端翻頁時要靠它當最後的決勝鍵。只用 order_date 排序，
-- 同一天的多筆紀錄在 Postgres 沒有保證順序，翻頁會出現重複或漏列；
-- 同一張單重複開同一項商品時，連 order_no 都不足以分辨。
-- ============================================
create or replace function product_cost_movements(
  p_product_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  item_id uuid,
  order_no text,
  order_date date,
  type text,
  qty int,
  subtotal numeric
)
language sql
stable
security invoker
as $$
  select
    oi.id,
    o.order_no,
    o.order_date,
    o.type,
    oi.qty,
    oi.subtotal
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.product_id = p_product_id
    and o.status = 'confirmed'
    and (p_from is null or o.order_date >= p_from)
    and (p_to   is null or o.order_date <= p_to)
  order by o.order_date desc, o.order_no desc, oi.id desc;
$$;

-- ============================================
-- 支援上述查詢的索引
-- 兩支函式都以 product_id 起手再依 order_date 排序，
-- 既有的 idx_order_items_product 只涵蓋前半段。
-- ============================================
create index if not exists idx_order_items_product_order
  on order_items (product_id, order_id);
