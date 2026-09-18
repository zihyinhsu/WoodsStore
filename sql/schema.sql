-- ============================================================
-- 進銷存系統 — 完整 schema（整併版）
-- ============================================================
-- 用途：在一個「全新」的 Supabase 專案上一次建到目前最終狀態。
--       等價於依序執行 migration.sql + patch-001 ~ patch-026 的結果，
--       但只保留每個物件的最終定義，並依相依關係重新排序。
--
-- 與原始 patch 系列的差異（刻意）：
--   1. 省略歷史中被推翻的中間版本（barcode 欄位、create_order 舊簽名、
--      反覆 drop/rebuild 的 view…），直接寫最終形態。
--   2. 省略一次性資料修復（patch-010 回填、patch-013 還原）與其稽核表
--      payment_allocation_migration_audit——那些只服務既有髒資料，新庫沒有。
--   3. 省略 patch-006/007 的 setval 校正與回填 do 區塊——新庫沒有既有資料，
--      序號從 0001 開始即為正解；校正只會讓第一號跳成 0002。
--   4. 已含 patch-017 身分驗證：撤掉 anon、只允許 authenticated。
--
-- ⚠️ 因為含 patch-017，套用前務必先完成：
--      1. Supabase → Authentication 建好員工帳號
--      2. Authentication → Providers → Email 關閉「Allow new users to sign up」
--      3. 前端 login 頁與 guard 已部署
--    否則套用後未登入（anon）會完全無法讀寫，連自己都被鎖在外面。
--
-- 成本口徑：成本快照（patch-018/019/020）。
--   出貨成本 = Σ(每筆出貨明細確認當下寫定的 unit_cost × 數量)，
--   不隨查詢區間漂移、也不受事後改 products.cost 影響。
--
-- 既有正式庫請勿套用本檔，改用增量 patch 升級；本檔只給新環境。
-- 使用方式：整份貼到 Supabase Dashboard → SQL Editor → Run。
-- ============================================================


-- ============================================================
-- 0. 擴充
-- ============================================================
-- 客戶餘額關鍵字搜尋用 ilike '%foo%'，前後都有通配符，B-tree 無法使用，
-- 需要 trigram 索引。pg_trgm 在 Supabase 為預設可用的擴充。
create extension if not exists pg_trgm;


-- ============================================================
-- 1. 資料表
-- ============================================================

-- ----------------------------------------
-- 商品
-- sku 允許為 null：交由 trigger 自動取號（見下方 set_product_sku）。
-- ----------------------------------------
create table products (
  id            uuid primary key default gen_random_uuid(),
  sku           text unique,                       -- 商品編號（未填由 trigger 補 P0001 起）
  name          text not null,                     -- 品名
  spec          text,                              -- 規格
  category      text,                              -- 分類
  unit          text default '個',                 -- 單位
  cost          numeric(12,2) default 0,           -- 進價
  price         numeric(12,2) default 0,           -- 售價
  tax_type      text default 'taxable'
                check (tax_type in ('taxable','free')),  -- 稅別
  safety_stock  int default 0,                     -- 安全庫存
  location      text,                              -- 儲位
  image_url     text,                              -- 商品圖片
  is_active     boolean default true,              -- 是否啟用
  created_at    timestamptz default now()
);

-- ----------------------------------------
-- 往來對象（供應商 / 客戶）
-- partner_no 未填由 trigger 依類型取號（客戶 C0001、供應商 S0001）。
-- ----------------------------------------
create table partners (
  id             uuid primary key default gen_random_uuid(),
  partner_no     text unique,                      -- 客戶／供應商編號
  name           text not null,                    -- 名稱
  type           text not null
                 check (type in ('supplier','customer')),
  tax_id         text,                             -- 統一編號
  contact_name   text,                             -- 聯絡人
  phone          text,
  address        text,
  payment_terms  text,                             -- 付款條件（例：月結30天）
  note           text,
  created_at     timestamptz default now()
);

-- ----------------------------------------
-- 單據主檔（進貨 / 銷貨 / 調整）
-- payment_status 欄位保留但為死值：付款狀態一律由收款紀錄推導
-- （見 order_payment_summary_view）。update_order_meta 會拒絕寫入。
-- ----------------------------------------
create table orders (
  id              uuid primary key default gen_random_uuid(),
  order_no        text unique not null,            -- 單號
  type            text not null
                  check (type in ('purchase','sale','adjust')),
  status          text not null default 'confirmed'
                  check (status in ('draft','confirmed','void')),  -- 草稿/確認/作廢
  partner_id      uuid references partners(id),
  order_date      date not null default current_date,
  discount        numeric(12,2) default 0,         -- 整單折讓
  tax             numeric(12,2) default 0,         -- 稅額
  payment_status  text default 'unpaid'
                  check (payment_status in ('unpaid','partial','paid')),
  note            text,
  created_at      timestamptz default now()
);

-- ----------------------------------------
-- 單據明細（＝庫存異動流水帳）
-- unit_cost：確認當下寫定的成本快照，草稿與調整單留 null（見 patch-018 口徑）。
-- ----------------------------------------
create table order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid not null references products(id),
  qty         int not null,                        -- 進貨為正、銷貨為負（由 RPC 控制）
  unit_price  numeric(12,2) not null default 0,
  discount    numeric(5,2) default 0,              -- 明細折扣（%）
  subtotal    numeric(12,2)
              generated always as (abs(qty) * unit_price * (1 - discount/100)) stored,
  unit_cost   numeric(12,2)                        -- 成本快照，確認當下寫定
);

comment on column order_items.unit_cost is
  '確認出貨當下寫定的成本快照。進貨=實付單價；出貨=截至出貨日的累計進貨加權平均。';

-- ----------------------------------------
-- 收款單
-- ----------------------------------------
create table payments (
  id            uuid primary key default gen_random_uuid(),
  payment_no    text unique not null,
  partner_id    uuid not null references partners(id),
  payment_date  date not null default current_date,
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'cash'
                check (method in ('cash','transfer','check')),
  note          text,
  created_at    timestamptz default now()
);

-- ----------------------------------------
-- 收款 ↔ 出貨單 逐單分配（一筆收款可沖多張出貨單）
-- amount 為「此筆收款分配到該張單的金額」，是付款狀態的單一事實來源。
-- ----------------------------------------
create table payment_orders (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references payments(id) on delete cascade,
  order_id    uuid not null references orders(id),
  amount      numeric(12,2) not null
              constraint payment_orders_amount_positive check (amount > 0),
  unique (payment_id, order_id)
);

comment on column payment_orders.amount is
  '此筆收款分配到該張出貨單的金額。單一事實來源，付款狀態由此推導。';


-- ============================================================
-- 2. 序號（用 sequence 而非 max()+1，避免併發取到同號）
-- ============================================================
create sequence if not exists partner_no_customer_seq start with 1;
create sequence if not exists partner_no_supplier_seq start with 1;
create sequence if not exists product_sku_seq          start with 1;


-- ============================================================
-- 3. 索引
-- ============================================================
create index idx_orders_order_date   on orders (order_date desc);
create index idx_orders_type_date    on orders (type, order_date desc);
create index idx_order_items_product on order_items (product_id);
create index idx_order_items_order   on order_items (order_id);
create index idx_payments_partner    on payments (partner_id, payment_date desc);
create index idx_payments_date       on payments (payment_date desc);
create index idx_payment_orders_payment on payment_orders (payment_id);
create index idx_payment_orders_order   on payment_orders (order_id);

-- 報表查詢：status + type + 日期
create index idx_orders_status_type_date
  on orders (status, type, order_date);

-- 單據分配總額驗證與收款彙總
create index idx_payment_orders_order_amount
  on payment_orders (order_id) include (amount);
create index idx_orders_sale_confirmed
  on orders (partner_id, order_date desc)
  where type = 'sale' and status = 'confirmed';

-- 單一商品成本明細分頁：product_id 起手再依 order 排序
create index idx_order_items_product_order
  on order_items (product_id, order_id);

-- 客戶餘額 as-of 查詢：payments 依日期截止再依 partner 聚合
create index idx_payments_date_partner
  on payments (payment_date, partner_id);

-- 客戶餘額關鍵字比對（trigram，支援 ilike '%foo%'）
create index idx_partners_name_trgm
  on partners using gin (name gin_trgm_ops);
create index idx_partners_partner_no_trgm
  on partners using gin (partner_no gin_trgm_ops);


-- ============================================================
-- 4. 視圖（依相依關係排序）
-- ============================================================

-- ----------------------------------------
-- 即時庫存（只計已確認單據）
-- ----------------------------------------
create view stock_view as
select p.id, p.sku, p.name, p.spec, p.category, p.unit,
       p.cost, p.price, p.tax_type, p.safety_stock, p.location,
       p.image_url, p.is_active, p.created_at,
       coalesce(sum(oi.qty) filter (where o.status = 'confirmed'), 0) as stock_qty
from products p
left join order_items oi on oi.product_id = p.id
left join orders o       on o.id = oi.order_id
group by p.id;

-- 低庫存（總覽卡片與清單共用，避免前端抓全表再過濾）
create view low_stock_view as
select *
from stock_view
where stock_qty < safety_stock;

-- ----------------------------------------
-- 單據金額（抽出重複的總額算式，供餘額／付款狀態共用同一定義）
-- discount / tax 可能為 null，一律 coalesce，否則整張單總額會變 null。
-- ----------------------------------------
create view order_total_view as
select
  o.id as order_id,
  o.partner_id,
  o.order_no,
  o.order_date,
  o.type,
  o.status,
  (coalesce(items.item_total, 0)
    - coalesce(o.discount, 0)
    + coalesce(o.tax, 0))::numeric(12,2) as order_total
from orders o
left join (
  select order_id, sum(subtotal)::numeric(12,2) as item_total
  from order_items
  group by order_id
) items on items.order_id = o.id;

-- ----------------------------------------
-- 單據收款彙總（付款狀態的唯一推導來源）
-- 只涵蓋已確認出貨單：進貨/調整/草稿/作廢單不談應收。
-- ----------------------------------------
create view order_payment_summary_view as
select
  ot.order_id,
  ot.partner_id,
  ot.order_no,
  ot.order_date,
  ot.order_total,
  coalesce(sum(po.amount), 0)::numeric(12,2) as paid_amount,
  greatest(ot.order_total - coalesce(sum(po.amount), 0), 0)::numeric(12,2) as outstanding_amount,
  case
    when coalesce(sum(po.amount), 0) <= 0             then 'unpaid'
    when coalesce(sum(po.amount), 0) < ot.order_total then 'partial'
    else 'paid'
  end as payment_status
from order_total_view ot
left join payment_orders po on po.order_id = ot.order_id
where ot.type = 'sale'
  and ot.status = 'confirmed'
group by
  ot.order_id, ot.partner_id, ot.order_no, ot.order_date, ot.order_total;

-- 未收清單：用 outstanding_amount > 0 判定，部分收款的單仍留在清單。
create view outstanding_order_view as
select
  s.order_id as id,
  s.partner_id,
  s.order_no,
  s.order_date,
  s.order_total,
  s.paid_amount,
  s.outstanding_amount,
  s.payment_status
from order_payment_summary_view s
where s.outstanding_amount > 0;

-- 相容層：舊前端仍查 unpaid_order_view，欄位名 order_total 對齊舊版。
create view unpaid_order_view as
select
  id,
  partner_id,
  order_no,
  order_date,
  outstanding_amount as order_total
from outstanding_order_view;

-- ----------------------------------------
-- 單據代表品項：列表用「商品摘要為主、單號為輔」時的商品來源。
-- 取金額最大的那一項——order_items 沒有 line_no 也沒有 created_at，
-- 「第一筆」沒有穩定順序；金額最大者既穩定，通常也是這張單的主角。
-- 單據管理、收款主表、沖帳明細共用這一份口徑（見 patch-025），
-- 各處一律 left join：沒有明細的單不會出現在這裡，取不到就由前端 fallback。
-- ----------------------------------------
create view order_top_item_view as
select
  oi.order_id,
  count(*) as item_count,
  (array_agg(pr.name order by oi.subtotal desc nulls last))[1] as top_item_name
from order_items oi
left join products pr on pr.id = oi.product_id
group by oi.order_id;

-- ----------------------------------------
-- 單據搜尋（時間區間 + 關鍵字）
-- payment_status 讀推導值；total_amount 為淨額（小計 − 折讓 + 稅），
-- 與付款狀態、partner_balance_view、dashboard_summary 同口徑。
-- item_count 仍在這裡自己 count：這裡是 left join orders，沒有明細的單要算 0，
-- 而 order_top_item_view 根本不會有那一列。
-- ----------------------------------------
create view order_search_view as
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

-- ----------------------------------------
-- 客戶應收餘額（全期間累計；as-of 版本見 get_partner_balances）
-- balance      = 出貨總額 − 累計收款（負數代表客戶溢付）
-- unallocated  = 已收但尚未指定沖哪張單的金額
-- ----------------------------------------
create view partner_balance_view as
with sales as (
  select partner_id, sum(order_total)::numeric(12,2) as total_sales
  from order_total_view
  where type = 'sale' and status = 'confirmed'
  group by partner_id
),
paid as (
  select partner_id, sum(amount)::numeric(12,2) as total_paid
  from payments
  group by partner_id
),
allocated as (
  select pay.partner_id, sum(po.amount)::numeric(12,2) as total_allocated
  from payment_orders po
  join payments pay on pay.id = po.payment_id
  group by pay.partner_id
)
select
  p.id, p.partner_no, p.name, p.type, p.phone,
  coalesce(s.total_sales, 0)::numeric(12,2)      as total_sales,
  coalesce(pa.total_paid, 0)::numeric(12,2)      as total_paid,
  coalesce(al.total_allocated, 0)::numeric(12,2) as total_allocated,
  (coalesce(pa.total_paid, 0) - coalesce(al.total_allocated, 0))::numeric(12,2)
    as unallocated_credit,
  (coalesce(s.total_sales, 0) - coalesce(pa.total_paid, 0))::numeric(12,2)
    as balance
from partners p
left join sales     s  on s.partner_id  = p.id
left join paid      pa on pa.partner_id = p.id
left join allocated al on al.partner_id = p.id
where p.type = 'customer';

-- ----------------------------------------
-- 對帳單明細（一行 = 一筆出貨明細）
-- ----------------------------------------
create view statement_line_view as
select
  o.partner_id,
  o.order_date,
  o.order_no,
  o.id as order_id,
  pr.name as product_name,
  pr.spec,
  abs(oi.qty) as qty,
  pr.unit,
  oi.unit_price,
  oi.subtotal
from orders o
join order_items oi on oi.order_id = o.id
join products pr    on pr.id = oi.product_id
where o.type = 'sale' and o.status = 'confirmed';

-- ----------------------------------------
-- 進出貨明細基底（含成本快照 unit_cost，供報表加總出貨成本）
-- ----------------------------------------
create view product_movement_base as
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
  -- 放在最後一欄：create or replace view 只能在尾端追加欄位，插在既有欄位間會報
  -- cannot change name of view column（既有欄的名稱與位置不可變動）。
  o.discount * oi.subtotal
    / nullif(sum(oi.subtotal) over (partition by oi.order_id), 0) as order_discount_alloc,
  -- patch-026 追加：客戶毛利要按客戶聚合，並算得出「這客戶期間內出了幾張單」。
  o.partner_id,
  o.id as order_id
from orders o
join order_items oi on oi.order_id = o.id
where o.status = 'confirmed'
  and o.type in ('purchase', 'sale');

-- ----------------------------------------
-- 收款搜尋
-- order_ids 供「從單據跳來」時 contains 過濾；order_nos 併進 search_text。
-- ----------------------------------------
create view payment_search_view as
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
  -- 一筆收款可能沖多張單，列表只放得下一張，因此取「分配金額最大」的那張當代表單，
  -- 張數另給 order_count 讓前端組「等 N 張」。amount 並列時再用日期、單號決勝，
  -- 否則翻頁重查可能換一張單顯示。
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

-- ----------------------------------------
-- 收款明細（展開某筆收款沖了哪些單、各沖多少）—— 編輯收款時載入既有分配用
-- ----------------------------------------
create view payment_allocation_view as
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


-- ============================================================
-- 5. 函式
-- ============================================================

-- ----------------------------------------
-- 5.1 序號取號 + trigger 函式
-- ----------------------------------------
create or replace function next_partner_no(p_type text)
returns text
language plpgsql
as $$
begin
  if p_type = 'supplier' then
    return 'S' || lpad(nextval('partner_no_supplier_seq')::text, 4, '0');
  end if;
  return 'C' || lpad(nextval('partner_no_customer_seq')::text, 4, '0');
end $$;

create or replace function set_partner_no()
returns trigger
language plpgsql
as $$
begin
  -- 空字串也視為未填，否則會寫入空值並佔用唯一鍵
  if new.partner_no is null or btrim(new.partner_no) = '' then
    new.partner_no := next_partner_no(new.type);
  end if;
  return new;
end $$;

create or replace function next_product_sku()
returns text
language plpgsql
as $$
begin
  return 'P' || lpad(nextval('product_sku_seq')::text, 4, '0');
end $$;

create or replace function set_product_sku()
returns trigger
language plpgsql
as $$
begin
  if new.sku is null or btrim(new.sku) = '' then
    new.sku := next_product_sku();
  end if;
  return new;
end $$;

-- ----------------------------------------
-- 5.2 成本快照底層
-- ----------------------------------------

-- 截至某日的累計進貨加權平均。無已確認進貨時回 null，交呼叫端 fallback。
create or replace function purchase_avg_cost_asof(
  p_product_id uuid,
  p_as_of date
) returns numeric
language sql
stable
security invoker
as $$
  select sum(oi.subtotal) / nullif(sum(abs(oi.qty)), 0)
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.product_id = p_product_id
    and o.status = 'confirmed'
    and o.type = 'purchase'
    and o.order_date <= p_as_of;
$$;

-- 把一張單的明細成本寫定。建單/確認與（原）backfill 共用同一支，口徑一致。
-- 進貨：實付單價 = subtotal / abs(qty)（subtotal 已含明細折扣）。
-- 出貨：as-of 累計進貨均價，無進貨退回 products.cost。
-- 調整單不在任何一條 update 範圍內，unit_cost 維持 null。
create or replace function snapshot_order_item_costs(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  update order_items oi
  set unit_cost = round(oi.subtotal / nullif(abs(oi.qty), 0), 2)
  from orders o
  where oi.order_id = p_order_id
    and o.id = oi.order_id
    and o.type = 'purchase';

  -- products 不能用 join ... on p.id = oi.product_id：oi 是 UPDATE 目標表，
  -- 不可在 FROM 的 join 條件被引用。改放進 FROM、關聯鍵移到 WHERE 才合法。
  update order_items oi
  set unit_cost = round(coalesce(
        purchase_avg_cost_asof(oi.product_id, o.order_date),
        p.cost
      ), 2)
  from orders o, products p
  where oi.order_id = p_order_id
    and o.id = oi.order_id
    and p.id = oi.product_id
    and o.type = 'sale';
end $$;

-- ----------------------------------------
-- 5.3 單據 RPC
-- ----------------------------------------

-- 建單（原子性 + 防超賣；確認當下寫定成本快照）
-- p_items 範例：[{"product_id":"uuid","qty":3,"unit_price":100,"discount":0}]
create or replace function create_order(
  p_type text,
  p_partner uuid,
  p_note text,
  p_items jsonb,
  p_order_date date default current_date,
  p_discount numeric default 0,
  p_tax numeric default 0,
  p_status text default 'confirmed'
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_sign int := case when p_type = 'purchase' then 1 else -1 end;
  v_stock int;
  v_qty int;
begin
  if p_type not in ('purchase','sale','adjust') then
    raise exception '無效的單據類型: %', p_type;
  end if;

  if p_status not in ('draft','confirmed') then
    raise exception '無效的單據狀態: %', p_status;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception '單據明細不可為空';
  end if;

  insert into orders (order_no, type, status, partner_id, order_date, discount, tax, note)
  values (
    'ORD-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4),
    p_type, p_status, p_partner, p_order_date, p_discount, p_tax, p_note
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'qty')::int;

    if p_type = 'adjust' then
      -- 調整單：qty 可正可負，直接採用
      v_sign := 1;
    elsif v_qty <= 0 then
      raise exception '數量必須大於 0';
    end if;

    -- 銷貨防超賣（草稿不佔庫存，確認時才檢查）
    if p_type = 'sale' and p_status = 'confirmed' then
      select coalesce(sum(oi.qty), 0) into v_stock
      from order_items oi
      join orders o on o.id = oi.order_id
      where oi.product_id = (v_item->>'product_id')::uuid
        and o.status = 'confirmed';

      if v_stock < v_qty then
        raise exception '庫存不足（現有 %，需求 %）', v_stock, v_qty;
      end if;
    end if;

    insert into order_items (order_id, product_id, qty, unit_price, discount)
    values (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_sign * v_qty,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'discount')::numeric, 0)
    );
  end loop;

  -- 確認當下寫定成本快照；草稿留 null，等 confirm_order 時才定。
  -- 放在迴圈後：此時 subtotal（generated column）已算好，可直接反推進貨實付單價。
  if p_status = 'confirmed' then
    perform snapshot_order_item_costs(v_order_id);
  end if;

  return v_order_id;
end $$;

-- 確認草稿單（銷貨此時才做防超賣檢查；通過後寫定成本快照）
create or replace function confirm_order(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_item record;
  v_stock int;
begin
  select type into v_type from orders
  where id = p_order_id and status = 'draft'
  for update;

  if not found then
    raise exception '單據不存在或非草稿狀態，無法確認';
  end if;

  if v_type = 'sale' then
    for v_item in
      select oi.product_id, abs(oi.qty) as need_qty, p.name
      from order_items oi
      join products p on p.id = oi.product_id
      where oi.order_id = p_order_id
    loop
      select coalesce(sum(oi.qty), 0) into v_stock
      from order_items oi
      join orders o on o.id = oi.order_id
      where oi.product_id = v_item.product_id
        and o.status = 'confirmed';

      if v_stock < v_item.need_qty then
        raise exception '庫存不足：%（現有 %，需求 %）', v_item.name, v_stock, v_item.need_qty;
      end if;
    end loop;
  end if;

  -- 確認的當下才寫定成本快照：as-of 均價以 order_date 為時序，
  -- 此時該單仍為 draft 不影響自身進貨均價（只算已確認進貨）。
  perform snapshot_order_item_costs(p_order_id);

  update orders set status = 'confirmed' where id = p_order_id;
end $$;

-- 作廢單據（草稿與已確認皆可；庫存自動回沖，因 stock_view 只計 confirmed）
create or replace function void_order(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  update orders set status = 'void'
  where id = p_order_id and status in ('draft', 'confirmed');

  if not found then
    raise exception '單據不存在或已作廢，無法作廢';
  end if;
end $$;

-- 編輯草稿單（整張替換 header + 明細）
-- 已確認/作廢不可經此修改；type 一律鎖定，改型別應作廢重開。
create or replace function update_draft_order(
  p_order_id uuid,
  p_partner uuid,
  p_note text,
  p_items jsonb,
  p_order_date date,
  p_discount numeric default 0,
  p_tax numeric default 0
) returns void
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_status text;
  v_item jsonb;
  v_qty int;
  v_unit_price numeric;
  v_product uuid;
begin
  -- 鎖定該列並重查狀態：與 confirm_order / void_order 序列化，
  -- 避免使用者開著編輯表單時單據已被他人確認。
  select type, status into v_type, v_status
  from orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_status <> 'draft' then
    raise exception 'ORDER_NOT_EDITABLE';
  end if;

  update orders
  set partner_id = p_partner,
      note       = p_note,
      order_date = coalesce(p_order_date, order_date),
      discount   = coalesce(p_discount, 0),
      tax        = coalesce(p_tax, 0)
  where id = p_order_id;

  delete from order_items where order_id = p_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product    := (v_item->>'product_id')::uuid;
    v_qty        := (v_item->>'qty')::int;
    v_unit_price := (v_item->>'unit_price')::numeric;

    if v_product is null then
      raise exception '明細缺少商品';
    end if;

    if v_type = 'adjust' then
      if v_qty = 0 then
        raise exception '調整數量不可為 0';
      end if;
    elsif v_qty is null or v_qty <= 0 then
      raise exception '數量必須大於 0';
    end if;

    if v_unit_price is null or v_unit_price < 0 then
      raise exception '單價不可為負數';
    end if;

    insert into order_items (order_id, product_id, qty, unit_price, discount)
    values (
      p_order_id,
      v_product,
      case
        when v_type = 'purchase' then abs(v_qty)
        when v_type = 'sale'     then -abs(v_qty)
        else v_qty
      end,
      v_unit_price,
      coalesce((v_item->>'discount')::numeric, 0)
    );
  end loop;
end $$;

-- 編輯單據備註（已確認/草稿皆可，作廢不可）
-- payment_status 由收款紀錄推導，一律拒絕寫入；保留參數只為相容舊前端。
create or replace function update_order_meta(
  p_order_id       uuid,
  p_note           text default null,
  p_payment_status text default null
) returns void
language plpgsql
security invoker
as $$
declare
  v_status text;
begin
  if p_payment_status is not null then
    raise exception 'PAYMENT_STATUS_READONLY: 付款狀態由收款紀錄推導，請至收款管理新增或修改收款';
  end if;

  select status into v_status
  from orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_status = 'void' then
    raise exception 'ORDER_NOT_EDITABLE';
  end if;

  update orders
  set note = coalesce(p_note, note)
  where id = p_order_id;
end $$;

-- ----------------------------------------
-- 5.4 收款分配 RPC + 驗證
-- ----------------------------------------

-- 原子儲存收款 + 逐單分配（取代前端三段式呼叫，任一段失敗都會留下不一致資料）。
-- 單號一律在 DB 端產生，避免前端併發產生重號。
create or replace function save_payment_with_allocations(
  p_partner_id   uuid,
  p_payment_date date,
  p_amount       numeric,
  p_method       text,
  p_note         text default null,
  p_allocations  jsonb default '[]'::jsonb,
  p_payment_id   uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_payment_id uuid;
  v_alloc      record;
  v_partner_ok boolean;
begin
  if p_partner_id is null then
    raise exception 'PAYMENT_PARTNER_REQUIRED';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'PAYMENT_AMOUNT_INVALID';
  end if;

  if p_method not in ('cash', 'transfer', 'check') then
    raise exception 'PAYMENT_METHOD_INVALID: %', p_method;
  end if;

  select true into v_partner_ok
  from partners
  where id = p_partner_id and type = 'customer';

  if not found then
    raise exception 'PAYMENT_PARTNER_INVALID: 收款對象必須是客戶';
  end if;

  if p_payment_id is null then
    insert into payments (payment_no, partner_id, payment_date, amount, method, note)
    values (
      'PAY-' || to_char(now(), 'YYYYMMDDHH24MISS')
             || '-' || upper(substr(md5(random()::text), 1, 4)),
      p_partner_id,
      coalesce(p_payment_date, current_date),
      p_amount,
      p_method,
      p_note
    )
    returning id into v_payment_id;
  else
    update payments
    set partner_id   = p_partner_id,
        payment_date = coalesce(p_payment_date, payment_date),
        amount       = p_amount,
        method       = p_method,
        note         = p_note
    where id = p_payment_id
    returning id into v_payment_id;

    if v_payment_id is null then
      raise exception 'PAYMENT_NOT_FOUND';
    end if;

    delete from payment_orders where payment_id = v_payment_id;
  end if;

  for v_alloc in
    select (x->>'order_id')::uuid       as order_id,
           (x->>'amount')::numeric(12,2) as amount
    from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) x
  loop
    if v_alloc.order_id is null then
      raise exception 'ALLOCATION_ORDER_REQUIRED';
    end if;

    if v_alloc.amount is null or v_alloc.amount <= 0 then
      raise exception 'ALLOCATION_AMOUNT_INVALID';
    end if;

    insert into payment_orders (payment_id, order_id, amount)
    values (v_payment_id, v_alloc.order_id, v_alloc.amount);
  end loop;

  -- 交易 commit 時，constraint trigger 會驗證：
  --   1. 分配總額 <= 收款金額
  --   2. 每張單分配總額 <= 單據金額
  --   3. 收款客戶 = 單據客戶
  --   4. 只能沖已確認的出貨單
  return v_payment_id;
end $$;

-- 跨列總額驗證（check constraint 不能跨列聚合，只能用 trigger）。
-- 搭配 constraint trigger + deferrable initially deferred，讓 RPC 能在同一交易內
-- 「先刪光舊分配、再插入新分配」，到 commit 才驗證，中間暫態不會被誤判。
create or replace function validate_payment_order_allocations()
returns trigger
language plpgsql
as $$
declare
  v_payment_id        uuid;
  v_order_id          uuid;
  v_payment_amount    numeric(12,2);
  v_payment_partner   uuid;
  v_payment_allocated numeric(12,2);
  v_order_total       numeric(12,2);
  v_order_partner     uuid;
  v_order_type        text;
  v_order_status      text;
  v_order_allocated   numeric(12,2);
begin
  v_payment_id := coalesce(new.payment_id, old.payment_id);
  v_order_id   := coalesce(new.order_id,   old.order_id);

  -- 收款可能在同一交易被刪除（例如 on delete cascade），此時無需驗證
  select amount, partner_id
    into v_payment_amount, v_payment_partner
  from payments
  where id = v_payment_id;

  if found then
    select coalesce(sum(amount), 0)::numeric(12,2)
      into v_payment_allocated
    from payment_orders
    where payment_id = v_payment_id;

    if v_payment_allocated > v_payment_amount then
      raise exception 'ALLOCATION_EXCEEDS_PAYMENT: 分配總額 % 超過收款金額 %',
        v_payment_allocated, v_payment_amount;
    end if;
  end if;

  select order_total, partner_id, type, status
    into v_order_total, v_order_partner, v_order_type, v_order_status
  from order_total_view
  where order_id = v_order_id;

  if found then
    if v_order_type <> 'sale' or v_order_status <> 'confirmed' then
      raise exception 'ALLOCATION_TARGET_INVALID: 只能沖帳已確認的出貨單';
    end if;

    select coalesce(sum(amount), 0)::numeric(12,2)
      into v_order_allocated
    from payment_orders
    where order_id = v_order_id;

    if v_order_allocated > v_order_total then
      raise exception 'ALLOCATION_EXCEEDS_ORDER: 單據分配總額 % 超過單據金額 %',
        v_order_allocated, v_order_total;
    end if;

    if v_payment_partner is not null
       and v_order_partner is not null
       and v_payment_partner <> v_order_partner then
      raise exception 'ALLOCATION_PARTNER_MISMATCH: 收款客戶與單據客戶不一致';
    end if;
  end if;

  return null;
end;
$$;

-- 保護既有單據不被改成低於已收金額（以 trigger 兜底 update_order_meta 之外的路徑）。
create or replace function guard_order_total_against_allocations()
returns trigger
language plpgsql
as $$
declare
  v_allocated  numeric(12,2);
  v_item_total numeric(12,2);
  v_new_total  numeric(12,2);
begin
  select coalesce(sum(po.amount), 0)::numeric(12,2)
    into v_allocated
  from payment_orders po
  where po.order_id = new.id;

  if v_allocated = 0 then
    return new;
  end if;

  if new.status = 'void' then
    raise exception 'ORDER_HAS_ALLOCATIONS: 此單據已有收款沖帳，請先移除收款分配再作廢';
  end if;

  -- 不能查 order_total_view：BEFORE UPDATE 階段資料列尚未寫入，
  -- view 讀到的仍是舊的 discount/tax，改小金額時會驗不出來。必須直接用 NEW 重算。
  select coalesce(sum(oi.subtotal), 0)::numeric(12,2)
    into v_item_total
  from order_items oi
  where oi.order_id = new.id;

  v_new_total := (v_item_total
                   - coalesce(new.discount, 0)
                   + coalesce(new.tax, 0))::numeric(12,2);

  if v_new_total < v_allocated then
    raise exception 'ORDER_TOTAL_BELOW_ALLOCATED: 單據金額 % 低於已收款 %',
      v_new_total, v_allocated;
  end if;

  return new;
end;
$$;

-- ----------------------------------------
-- 5.5 報表 RPC（成本一律讀出貨明細的成本快照）
-- ----------------------------------------

-- 期間內逐商品的進出貨彙總與出貨成本
-- cost = Σ(出貨明細 unit_cost × 數量)。unit_cost 可能為 null（成本未知），以 0 計入。
create or replace function product_movement(
  p_from date,
  p_to date
) returns table (
  product_id uuid,
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric,
  cost numeric
)
language sql
stable
security invoker
as $$
  select
    m.product_id,
    coalesce(sum(m.qty)      filter (where m.type = 'purchase'), 0),
    -- 進/出貨金額扣掉分攤到本列的整單折讓（未稅、含折讓）；數量與成本快照不受折讓影響。
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.qty)      filter (where m.type = 'sale'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'sale'), 0),
    coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.type = 'sale'), 0)
  from product_movement_base m
  where m.order_date between p_from and p_to
  group by m.product_id;
$$;

-- 期間損益彙總（含稅檢視用；總覽卡片已改走 product_cost_analysis_summary 的全未稅口徑）
-- 收益／支出 = 明細小計 − 整單折讓 + 稅額（含稅，收付視角）；
-- 成本 = Σ 各商品出貨成本快照；
-- 毛利 = 未稅銷貨淨額（含折讓）− 成本。稅是代收代付、不是收入，故毛利一律未稅，
--        不可用含稅的 revenue 去減成本（那會讓毛利被稅額灌水）。
-- 回傳欄位新增 profit，型別變動，必須先 drop 再 create（create or replace 不允許改回傳型別）。
drop function if exists dashboard_summary(date, date);
create function dashboard_summary(
  p_from date,
  p_to date
) returns table (
  revenue numeric,
  expense numeric,
  cost numeric,
  profit numeric
)
language sql
stable
security invoker
as $$
  with order_totals as (
    select
      o.id,
      o.type,
      coalesce(sum(oi.subtotal), 0) - o.discount + o.tax as net_amount
    from orders o
    left join order_items oi on oi.order_id = o.id
    where o.status = 'confirmed'
      and o.type in ('purchase', 'sale')
      and o.order_date between p_from and p_to
    group by o.id
  ),
  movement as (
    -- 與明細表同口徑：sale_net 為未稅、已含折讓（product_movement 已扣分攤折讓）。
    select
      coalesce(sum(sale_amount), 0) as sale_net,
      coalesce(sum(cost), 0)        as cost
    from product_movement(p_from, p_to)
  )
  select
    coalesce(sum(net_amount) filter (where type = 'sale'), 0),
    coalesce(sum(net_amount) filter (where type = 'purchase'), 0),
    (select cost from movement),
    (select sale_net - cost from movement)
  from order_totals;
$$;

-- 逐商品進出貨成本分析（一商品一列；前端以 order/range 分頁）
-- p_with_movement_only = true 時只留期間內有進出貨的商品。
create or replace function product_cost_analysis(
  p_from date,
  p_to date,
  p_with_movement_only boolean default false
) returns table (
  product_id uuid,
  sku text,
  name text,
  unit text,
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric,
  estimated_cost numeric,
  estimated_profit numeric
)
language sql
stable
security invoker
as $$
  select
    p.id,
    p.sku,
    p.name,
    p.unit,
    coalesce(m.purchase_qty, 0),
    coalesce(m.purchase_amount, 0),
    coalesce(m.sale_qty, 0),
    coalesce(m.sale_amount, 0),
    coalesce(m.cost, 0),
    coalesce(m.sale_amount - m.cost, 0)
  from products p
  left join product_movement(p_from, p_to) m on m.product_id = p.id
  where m.product_id is not null or not p_with_movement_only;
$$;

-- 逐商品分析的期間合計（金額為未稅、已扣分攤的整單折讓，與 product_movement 同口徑）
-- 總覽上方四張卡片也走這支，讓卡片與下方明細清單的合計必定相等。
create or replace function product_cost_analysis_summary(
  p_from date,
  p_to date
) returns table (
  purchase_amount numeric,
  sale_amount numeric,
  estimated_cost numeric
)
language sql
stable
security invoker
as $$
  select
    coalesce(sum(purchase_amount), 0),
    coalesce(sum(sale_amount), 0),
    coalesce(sum(cost), 0)
  from product_movement(p_from, p_to);
$$;

-- 單一商品的期間彙總（供商品頁毛利與「平均出貨成本」卡）
-- 改由 product_movement_base 取數，與總覽的成本分析同口徑：金額含整單折讓、未稅。
-- cost = Σ(出貨明細 unit_cost × abs(qty))，成本快照不受折讓影響。調整單本就不在該 view。
create or replace function product_cost_detail_summary(
  p_product_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  purchase_qty bigint,
  purchase_amount numeric,
  sale_qty bigint,
  sale_amount numeric,
  cost numeric
)
language sql
stable
security invoker
as $$
  select
    coalesce(sum(m.qty) filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'purchase'), 0),
    coalesce(sum(m.qty) filter (where m.type = 'sale'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'sale'), 0),
    coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.type = 'sale'), 0)
  from product_movement_base m
  where m.product_id = p_product_id
    and (p_from is null or m.order_date >= p_from)
    and (p_to   is null or m.order_date <= p_to);
$$;

-- 單一商品的期間進出明細（供前端分頁）
-- 這裡「不」過濾 type：調整單也要顯示，讓使用者看得到庫存被校正過。
-- item_id 一定要輸出：翻頁時當最後的決勝鍵，避免同日多筆順序不定造成重複或漏列。
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

-- 客戶應收餘額（截至指定日期、可依客戶或關鍵字篩選、由前端分頁）
-- 口徑選「期末快照」而非「期間發生額」：積欠但近期沒下單的客戶餘額才不會顯示 0。
-- 三個 CTE 的截止日必須一致，只截其中一側會讓 unallocated_credit 變負數。
-- p_partner_id / p_keyword 凌駕 p_include_settled：明確指定就必須看得到，即使已結清。
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
    select nullif(btrim(coalesce(p_keyword, '')), '') as keyword
  ),
  pattern as (
    -- % 與 _ 是 like 通配符必須跳脫，否則使用者輸入 % 會匹配全部客戶。
    -- 反斜線要先跳脫，順序相反會把後續補上的跳脫字元再跳脫一次。
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
      or p.partner_no           ilike pt.like_pattern escape '\'
      or p.name                 ilike pt.like_pattern escape '\'
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

-- 總覽頁圖表：按月進出貨趨勢（成本可加，直接取每筆快照 unit_cost 於「月」層級加總）
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
      -- 與 product_movement 同口徑：金額扣掉分攤的整單折讓（未稅、含折讓）。
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'purchase'), 0) as purchase_amount,
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.type = 'sale'), 0)     as sale_amount,
      coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.type = 'sale'), 0) as cost
    from product_movement_base m
    where m.order_date between p_from and p_to
    group by date_trunc('month', m.order_date)
  )
  select
    month,
    purchase_amount,
    sale_amount,
    coalesce(sale_amount - cost, 0)
  from monthly
  order by month;
$$;

-- 總覽頁圖表：商品毛利排行（頭尾各 p_limit 名，union 去重、由高到低排序）
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
      coalesce(m.sale_amount - m.cost, 0) as estimated_profit
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

-- ----------------------------------------
-- 5.6 客戶毛利（patch-026）
-- 口徑與上方商品成本分析完全一致：收益未稅、已扣分攤整單折讓，成本讀 unit_cost 快照。
-- 兩個必須知道的失真來源，都以欄位回報給前端而非默默吞掉：
--   1. unit_cost 為 null 以 0 計入成本 → 毛利高估，故回傳 no_cost_qty。
--   2. partner_id 為 null 的出貨單不屬於任何客戶 → 客戶毛利合計會小於
--      product_cost_analysis_summary 的同期毛利，差額即這些無客戶單據。
-- ----------------------------------------

-- 逐客戶毛利（一客戶一列；排序與分頁交給前端，同 product_cost_analysis）
-- 只回期間內有出貨的客戶：沒出貨就沒有毛利可談，列出來只是一堆 0。
-- p_partner_id 指定時只回那一位客戶——modal 要「單一客戶 × 自訂區間」的彙總，
-- 走這裡才與清單同一套算式，不必在前端另湊一份數字（同 get_partner_balances 的做法）。
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
    -- 與 get_partner_balances 同一段跳脫寫法，勿各寫一份。
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

-- 客戶毛利排行（總覽橫條圖）：頭尾各 p_limit 名，結構照 cost_ranking。
-- 帶 p_keyword：圖與表格吃同一組篩選，否則搜尋後兩邊講的是不同客戶群。
-- 除了 profit 還回出貨額／成本／單數：長條只畫得出毛利一個維度，滑過去的 tooltip
-- 要答得出「這條為什麼這麼長」（薄利多銷還是量小利厚），否則得再去表格找同一位客戶。
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

-- 客戶毛利的期間合計。直接對 partner_profit 加總而非另寫聚合：
-- 合計列與清單因此恆等，不會出現兩組差一點的數字讓人無從判斷哪個才算數。
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

-- 單一客戶的商品組成（點列後 modal 的明細；前端分頁）
-- 回答「在這個客戶身上是靠什麼賺的」。單據層級的查帳有對帳單與單據管理，
-- 這裡刻意只做商品維度。
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

-- ----------------------------------------
-- 對帳單彙總：期間內有出貨或收款的客戶，各自的期前餘額與本期發生額
-- 口徑與明細頁一致：金額取 statement_line_view.subtotal（明細小計、不含整單折讓與稅），
-- 刻意與 partner_balance_view 的 order_total（含折讓、含稅）不同——對帳單自成一套口徑。
-- 動這裡前先確認是否要連 statement_line_view 一起改，否則左欄合計會與右欄明細對不起來。
-- 只回「有出貨或有收款」的客戶：期前有往來但本期無異動者不列入對帳單。
-- ----------------------------------------
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


-- ============================================================
-- 6. Trigger
-- ============================================================
drop trigger if exists trg_set_partner_no on partners;
create trigger trg_set_partner_no
  before insert on partners
  for each row
  execute function set_partner_no();

drop trigger if exists trg_set_product_sku on products;
create trigger trg_set_product_sku
  before insert on products
  for each row
  execute function set_product_sku();

-- constraint trigger + deferrable：讓 RPC 能在同一交易先刪後插，commit 時才驗證。
drop trigger if exists payment_orders_validate_allocations on payment_orders;
create constraint trigger payment_orders_validate_allocations
  after insert or update or delete on payment_orders
  deferrable initially deferred
  for each row
  execute function validate_payment_order_allocations();

drop trigger if exists orders_guard_allocations on orders;
create trigger orders_guard_allocations
  before update on orders
  for each row
  execute function guard_order_total_against_allocations();


-- ============================================================
-- 7. RLS 與權限（只允許 authenticated；anon 全撤）
-- ============================================================
-- 全站需登入、全員同權，anon 不需任何存取。
-- view 多為 definer 語意會繞過 table RLS，故除了 policy，還要在 schema 層撤掉
-- anon 的 grant，一次涵蓋 table / view / function，避免逐一列舉 view 而漏掉。

alter table products       enable row level security;
alter table partners       enable row level security;
alter table orders         enable row level security;
alter table order_items    enable row level security;
alter table payments       enable row level security;
alter table payment_orders enable row level security;

create policy "authenticated full access" on products
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on partners
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on orders
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on order_items
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on payments
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on payment_orders
  for all to authenticated using (true) with check (true);

-- 撤掉 anon 對 public schema 的所有存取（含 view / function）
revoke all on all tables    in schema public from anon;
revoke all on all routines  in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 未來新建的物件也預設不開放 anon
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on routines  from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- 確保 authenticated 有必要權限（Supabase 預設已 grant，這裡明示以防環境差異）
grant usage on schema public to authenticated;
grant all on all tables    in schema public to authenticated;
grant all on all routines  in schema public to authenticated;
grant all on all sequences in schema public to authenticated;

alter default privileges in schema public grant all on tables    to authenticated;
alter default privileges in schema public grant all on routines  to authenticated;
alter default privileges in schema public grant all on sequences to authenticated;


-- ============================================================
-- 8. 範例資料（可選；不需要可整段刪除）
-- ============================================================
-- partner_no 由 trigger 自動補號；products 明確給 sku 則沿用不覆蓋。
insert into partners (name, type, tax_id, contact_name, phone) values
  ('大同五金行', 'supplier', '12345678', '陳老闆', '02-1234-5678'),
  ('王小明', 'customer', null, '王小明', '0912-345-678');

insert into products (sku, name, spec, category, unit, cost, price, safety_stock, location) values
  ('P001', '不鏽鋼螺絲', 'M4x10mm', '五金', '包', 20, 35, 10, 'A1-01'),
  ('P002', '電工膠帶', '黑色 18mm', '耗材', '捲', 8, 15, 20, 'A2-03'),
  ('P003', 'LED 燈泡', 'E27 10W 白光', '照明', '顆', 45, 79, 5, 'B1-02');
