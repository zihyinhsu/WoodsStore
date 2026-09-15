-- ============================================================
-- patch-019：總覽頁進出貨成本分析圖表所需的聚合 RPC
--
-- 圖表要的是「按時間分佈」與「跨全部商品排序」的資料，這兩者現有的
-- product_cost_analysis（單列聚合、分頁）都給不出來。依專案原則——聚合在
-- 資料庫做、前端只拿彙總結果——這裡新增兩支唯讀函式：
--   cost_trend   ：按月的進貨金額 / 出貨金額 / 估算毛利（趨勢圖 A）
--   cost_ranking ：期間內各商品毛利，取頭尾各 N 名（排行圖 B）
--
-- 口徑一律沿用 patch-008 的 product_movement_base / product_movement，
-- 才會與表格、期間合計一致：只計 status='confirmed' 的 purchase / sale，
-- 調整單（adjust）不列入，出貨成本以「進貨均價」估算、無均價時退回 products.cost。
-- （避開快照分支 feat/order-item-cost-snapshot 預定的 patch-018 編號。）
-- ============================================================

-- ============================================
-- 按月進出貨趨勢
--
-- 均價的計算窗口刻意「按月」而非「整個查詢區間」：趨勢圖要讓每個月各自成立，
-- 某月的出貨成本就用該月的進貨均價估。這與 product_cost_analysis 是同一條公式
-- （進貨額 / 進貨量，無進貨退回 products.cost），只是把套用的區間縮到單一月份。
-- 因此各月毛利加總不必然等於整段區間的合計——那正是「月」與「期間」的差異，非 bug。
-- ============================================
create or replace function cost_trend(
  p_from date,
  p_to date
) returns table (
  month date,
  purchase_amount numeric,
  sale_amount numeric,
  estimated_profit numeric
)
language sql
stable
security invoker
as $$
  with monthly as (
    select
      date_trunc('month', m.order_date)::date as month,
      m.product_id,
      coalesce(sum(m.qty)      filter (where m.type = 'purchase'), 0) as purchase_qty,
      coalesce(sum(m.subtotal) filter (where m.type = 'purchase'), 0) as purchase_amount,
      coalesce(sum(m.qty)      filter (where m.type = 'sale'), 0)     as sale_qty,
      coalesce(sum(m.subtotal) filter (where m.type = 'sale'), 0)     as sale_amount,
      coalesce(
        sum(m.subtotal) filter (where m.type = 'purchase')
          / nullif(sum(m.qty) filter (where m.type = 'purchase'), 0),
        p.cost
      ) as unit_cost
    from product_movement_base m
    join products p on p.id = m.product_id
    where m.order_date between p_from and p_to
    group by date_trunc('month', m.order_date), m.product_id, p.cost
  )
  select
    month,
    coalesce(sum(purchase_amount), 0),
    coalesce(sum(sale_amount), 0),
    coalesce(sum(sale_amount - sale_qty * unit_cost), 0)
  from monthly
  group by month
  order by month;
$$;

-- ============================================
-- 商品毛利排行（頭尾各 p_limit 名）
--
-- 直接複用 product_movement(p_from, p_to)，毛利口徑與 product_cost_analysis 逐項對齊
-- （整段區間的進貨均價）。只回「最賺 N + 最虧 N」共至多 2×p_limit 列，商品數少於
-- 這個上限時 union 去重、自然只回實際筆數，不補空列。最後統一由高到低排序，
-- 前端拿到就能直接畫：正毛利與負毛利以不同顏色區分。
-- ============================================
create or replace function cost_ranking(
  p_from date,
  p_to date,
  p_limit int default 5
) returns table (
  product_id uuid,
  sku text,
  name text,
  estimated_profit numeric
)
language sql
stable
security invoker
as $$
  with ranked as (
    select
      p.id as product_id,
      p.sku,
      p.name,
      coalesce(m.sale_amount - m.sale_qty * m.unit_cost, 0) as estimated_profit
    from product_movement(p_from, p_to) m
    join products p on p.id = m.product_id
  )
  select * from (
    (select * from ranked order by estimated_profit desc, sku asc limit p_limit)
    union
    (select * from ranked order by estimated_profit asc,  sku asc limit p_limit)
  ) top_bottom
  order by estimated_profit desc, sku asc;
$$;
