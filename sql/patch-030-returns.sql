-- patch-030-returns
-- 退貨流程：銷貨退回（sale_return）與進貨退出（purchase_return）
--
-- 設計決策（完整規格見 docs/returns-plan.md，這裡只留動 SQL 前必須知道的理由）：
--   - 另開兩種單據類型，而不是用負數量的 sale／purchase：現有查詢多半寫死
--     type in ('sale','purchase')，退貨單預設不會被悄悄算錯，要納入的地方一處一處明確改。
--   - 連回原單用 orders.return_of_order_id／order_items.return_of_item_id，不用 parent_order_id：
--     後者是分批進出貨的分組鍵（只允許兩層、同類型），退貨用它會被 search_order_groups 併進同一組的合計。
--     明細層級連結是因為同一張單可能有同商品不同單價的兩列，要靠它限制每列可退數量並沿用成本快照。
--   - 正負號：錢往哪個方向就用哪個正負號。退貨單的 order_total、沖帳 payment_orders.amount 為負，
--     庫存 qty 銷貨退回為 +、進貨退出為 −。照這個正負號一路加總，客戶餘額、對帳單、收款淨額
--     自然正確。order_items.subtotal 是 abs(qty) 的生成欄位、恆為正，所有自己加總 subtotal 的地方
--     （order_total_view、order_search_view、dashboard_summary、product_movement_base、
--     purchase_avg_cost_asof、product_cost_movements、statement_line_view）都靠 order_amount_sign 補號。
--   - 退貨記在退貨日那一期，收款時與出貨單一起勾選直接抵掉；原單的金額與收款狀態都不動。
--   - 0 元沖帳單：換貨時退貨剛好抵掉出貨、沒有現金進出，仍要留一筆沖帳紀錄把兩張單結掉。
--     payments.amount 放寬為 >= 0，但 0 元收款必須有分配且淨額為 0。
--     一筆收款的分配淨額規則：0 <= 淨額 <= 收款金額。
--
-- 對舊前端的相容性：舊前端的收款頁用 outstanding_amount > 0 篩選、退貨單只能從新前端建立，
-- 所以先跑這份 patch、再部署前端是安全的。unpaid_order_view 刻意只留 > 0（見該 view 的註解）。
--
-- 整份在一個交易內，且可重複執行：欄位 add column if not exists、check 先 drop 再 add、
-- view／函式一律 create or replace（view 只在尾端追加欄位）、trigger 先 drop 再 create、
-- 索引以 pg_indexes 判斷是否已是新定義。簽名都沒變動，不需 drop 舊函式。
-- 套用後請接著跑 sql/verify-030-returns.sql。

begin;

-- ============================================================
-- 0. Schema
-- ============================================================
alter table orders      add column if not exists return_of_order_id uuid references orders(id);
alter table order_items add column if not exists return_of_item_id  uuid references order_items(id);

comment on column orders.return_of_order_id is
  '退貨單退自哪張原單（sale_return 指向 sale、purchase_return 指向 purchase）。一張退貨單只對應一張原單。';

-- 用明細層級連結而不只連到原單：同一張單可能有同商品不同單價的兩列，
-- 要靠它限制每列可退數量，並沿用該列的成本快照。
comment on column order_items.return_of_item_id is
  '退貨明細退自原單的哪一列。用來限制每列可退數量（原數量 − 有效退貨合計）並沿用該列的 unit_cost。';

comment on column payment_orders.amount is
  '此筆收付款分配到該張單據（出貨單、進貨單或退貨單）的金額，正負號與單據金額一致（退貨單為負）。單一事實來源，付款狀態由此推導。';

-- check constraint 沒有 add if not exists，重跑時先 drop 再 add（表很小，重驗成本可忽略）。
alter table orders drop constraint if exists orders_type_check;
alter table orders add constraint orders_type_check
  check (type in ('purchase','sale','adjust','sale_return','purchase_return'));

-- 退貨單一定要有原單、其他類型一定不能有：連結欄位與類型必須同進退，
-- 否則會出現「沒有原單的退貨」（可退數量無從限制）或「掛著原單的一般單」。
alter table orders drop constraint if exists orders_return_link_check;
alter table orders add constraint orders_return_link_check
  check ((type in ('sale_return','purchase_return')) = (return_of_order_id is not null));

-- 允許 0：換貨時退貨剛好抵掉出貨、沒有現金進出。0 元收款必須有分配且淨額為 0，
-- 由 assert_payment_allocation_net 把關。
alter table payments drop constraint if exists payments_amount_check;
alter table payments add constraint payments_amount_check check (amount >= 0);

-- 退貨單的分配為負數（正負號與單據金額一致），所以只擋 0；
-- 正負號是否與單據類型相符，要看單據才知道，交給 validate_payment_order_allocations。
alter table payment_orders drop constraint if exists payment_orders_amount_positive;
alter table payment_orders drop constraint if exists payment_orders_amount_nonzero;
alter table payment_orders add constraint payment_orders_amount_nonzero check (amount <> 0);

-- 同時涵蓋 sale_return：statement_line_view 的條件是 type in ('sale','sale_return')，
-- partial index 的 where 必須蘊含查詢條件才用得上，只寫 type = 'sale' 對帳單會退回掃全表。
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'idx_orders_sale_confirmed'
      and indexdef like '%sale_return%'
  ) then
    drop index if exists idx_orders_sale_confirmed;
    create index idx_orders_sale_confirmed
      on orders (partner_id, order_date desc)
      where type in ('sale', 'sale_return') and status = 'confirmed';
  end if;
end $$;

-- 退貨：依原單找退貨單（可退數量、ORDER_HAS_RETURNS、return_count）
create index if not exists idx_orders_return_of
  on orders (return_of_order_id)
  where return_of_order_id is not null;

-- 退貨：依原明細列算已退數量
create index if not exists idx_order_items_return_of
  on order_items (return_of_item_id)
  where return_of_item_id is not null;

-- ============================================================
-- 1. 判斷正負號的共用函式（view 與函式都依賴它，必須最先建）
-- ============================================================
-- ----------------------------------------
-- 金額正負號：錢往哪個方向就用哪個正負號（退貨單為 -1，其餘 1）
-- order_items.subtotal 是 abs(qty) 算出的生成欄位、恆為正，凡是自己從 subtotal 加總的地方
-- （order_total_view、order_search_view、dashboard_summary、product_movement_base、
-- purchase_avg_cost_asof、product_cost_movements、statement_line_view）都靠這支補正負號，
-- 判斷規則只留一份：日後再加類型，不必在十幾處各改一次。
-- ----------------------------------------
create or replace function order_amount_sign(p_type text)
returns int
language sql
immutable
parallel safe
as $$
  select case when p_type in ('sale_return', 'purchase_return') then -1 else 1 end;
$$;

-- ============================================================
-- 2. 視圖（依相依順序；create or replace view 只能在尾端追加欄位，既有欄位型別不可變）
-- ============================================================

-- ----------------------------------------
-- 單據金額（抽出重複的總額算式，供餘額／付款狀態共用同一定義）
-- discount / tax 可能為 null，一律 coalesce，否則整張單總額會變 null。
-- 退貨單（sale_return／purchase_return）的 order_total 為負數：照這個正負號一路加總，
-- 客戶餘額、對帳單、收款淨額自然正確，不需要每處各自判斷「是不是退貨」。
-- ----------------------------------------
create or replace view order_total_view as
select
  o.id as order_id,
  o.partner_id,
  o.order_no,
  o.order_date,
  o.type,
  o.status,
  (order_amount_sign(o.type) * (coalesce(items.item_total, 0)
    - coalesce(o.discount, 0)
    + coalesce(o.tax, 0)))::numeric(12,2) as order_total
from orders o
left join (
  select order_id, sum(subtotal)::numeric(12,2) as item_total
  from order_items
  group by order_id
) items on items.order_id = o.id;

-- ----------------------------------------
-- 單據收付款彙總（付款狀態的唯一推導來源）
-- 涵蓋已確認的出貨單（應收）、進貨單（應付）與兩種退貨單，以 type 區分；調整/草稿/作廢單不談收付。
-- type 放在最後一欄：create or replace view 只能在尾端追加欄位（patch-027）。
-- 退貨單的 order_total、paid_amount、outstanding_amount 都是負數（「待抵扣」額度），
-- 所以 outstanding 對退貨單用 least(…, 0)；狀態比較也全改用絕對值，
-- 否則 paid 為負的退貨單會被 <= 0 判成永遠未抵扣（patch-030）。
-- ----------------------------------------
create or replace view order_payment_summary_view as
select
  ot.order_id,
  ot.partner_id,
  ot.order_no,
  ot.order_date,
  ot.order_total,
  coalesce(sum(po.amount), 0)::numeric(12,2) as paid_amount,
  (case
    when ot.order_total < 0 then least(ot.order_total - coalesce(sum(po.amount), 0), 0)
    else greatest(ot.order_total - coalesce(sum(po.amount), 0), 0)
  end)::numeric(12,2) as outstanding_amount,
  case
    when abs(coalesce(sum(po.amount), 0)) = 0              then 'unpaid'
    when abs(coalesce(sum(po.amount), 0)) < abs(ot.order_total) then 'partial'
    else 'paid'
  end as payment_status,
  ot.type
from order_total_view ot
left join payment_orders po on po.order_id = ot.order_id
where ot.type in ('sale', 'purchase', 'sale_return', 'purchase_return')
  and ot.status = 'confirmed'
group by
  ot.order_id, ot.partner_id, ot.order_no, ot.order_date, ot.order_total, ot.type;

-- 未收清單：用 outstanding_amount <> 0 判定，部分收款的單仍留在清單。
-- 只留出貨單與銷貨退回單：這支是「應收」的定義來源，
-- 應付混進來會讓供應商被當成要追款的對象。未付進貨單直接查 order_payment_summary_view。
-- 銷貨退回單的 outstanding 為負（待抵扣額度），所以不能再用 > 0 判斷（patch-030）。
create or replace view outstanding_order_view as
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
where s.type in ('sale', 'sale_return')
  and s.outstanding_amount <> 0;

-- 相容層：舊前端仍查 unpaid_order_view，欄位名 order_total 對齊舊版。
-- 刻意只留 > 0：舊前端與追款清單把這支當「客戶還欠多少」，
-- 待抵扣的退貨（負數）混進來會在不知情的情況下被當成欠款加總（patch-030）。
create or replace view unpaid_order_view as
select
  id,
  partner_id,
  order_no,
  order_date,
  outstanding_amount as order_total
from outstanding_order_view
where outstanding_amount > 0;

-- ----------------------------------------
-- 單據搜尋（時間區間 + 關鍵字）
-- payment_status 讀推導值；total_amount 為淨額（小計 − 折讓 + 稅），
-- 與付款狀態、partner_balance_view、dashboard_summary 同口徑。
-- item_count 仍在這裡自己 count：這裡是 left join orders，沒有明細的單要算 0，
-- 而 order_top_item_view 根本不會有那一列。
-- search_text 併入原單單號（patch-028）：搜原單號就能撈出整組。
-- 群組欄位只能追加在尾端：create or replace view 不能調整既有欄位順序。
-- group_size 不計作廢單：作廢的那批貨已經不存在，算進去會讓「共 N 批」對不上實際張數。
-- patch-030 退貨：total_amount 是自己從 subtotal 算的（不讀 order_total_view，subtotal 恆為正），
-- 退貨單要自己乘上正負號變負數，search_order_groups 的組合計也靠它；
-- payment_status 要納入兩種退貨類型，否則列表顯示不出「未抵扣／已抵扣」；
-- search_text 併入原單單號：搜原單號會一併撈出它的退貨單。
-- return_* 三欄同樣只能追加在尾端。return_count 不計作廢的退貨單，與 group_size 同理。
-- ----------------------------------------
create or replace view order_search_view as
select
  o.id, o.order_no, o.type, o.status, o.order_date,
  o.discount, o.tax, o.note, o.created_at,
  o.partner_id,
  p.name as partner_name,
  count(oi.id) as item_count,
  (order_amount_sign(o.type) * (coalesce(sum(oi.subtotal), 0)
    - coalesce(o.discount, 0)
    + coalesce(o.tax, 0)))::numeric(12,2) as total_amount,
  case
    when o.type in ('sale', 'purchase', 'sale_return', 'purchase_return') and o.status = 'confirmed'
      then coalesce(ops.payment_status, 'unpaid')
    else null
  end as payment_status,
  ops.paid_amount,
  ops.outstanding_amount,
  o.order_no || ' ' || coalesce(o.note,'')
    || ' ' || coalesce(p.name,'') || ' ' || coalesce(p.tax_id,'')
    || ' ' || coalesce(string_agg(pr.name || ' ' || pr.sku, ' '), '')
    || ' ' || coalesce((select r.order_no from orders r where r.id = o.parent_order_id), '')
    || ' ' || coalesce((select r.order_no from orders r where r.id = o.return_of_order_id), '')
    as search_text,
  ti.top_item_name,
  o.parent_order_id,
  coalesce(o.parent_order_id, o.id) as group_root_id,
  (select r.order_no from orders r where r.id = coalesce(o.parent_order_id, o.id)) as group_root_no,
  (select count(*) from orders g
    where (g.id = coalesce(o.parent_order_id, o.id)
           or g.parent_order_id = coalesce(o.parent_order_id, o.id))
      and g.status <> 'void') as group_size,
  o.return_of_order_id,
  (select r.order_no from orders r where r.id = o.return_of_order_id) as return_of_order_no,
  (select count(*) from orders r
    where r.return_of_order_id = o.id and r.status = 'confirmed') as return_count
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
-- 出貨總額含銷貨退回（order_total 為負），退貨在退貨日那一期直接減掉應收（patch-030）。
-- ----------------------------------------
create or replace view partner_balance_view as
with sales as (
  select partner_id, sum(order_total)::numeric(12,2) as total_sales
  from order_total_view
  where type in ('sale', 'sale_return') and status = 'confirmed'
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
-- 對帳單明細（一行 = 一筆出貨明細；銷貨退回的明細 qty、subtotal 為負數）
-- type 追加在尾端（create or replace view 只能追加欄位），供前端標「退貨」。
-- statement_summary 直接加總 subtotal，帶號之後退貨自然抵掉出貨，不必另外判斷。
-- ----------------------------------------
create or replace view statement_line_view as
select
  o.partner_id,
  o.order_date,
  o.order_no,
  o.id as order_id,
  pr.name as product_name,
  pr.spec,
  (abs(oi.qty) * order_amount_sign(o.type)) as qty,
  pr.unit,
  oi.unit_price,
  (order_amount_sign(o.type) * oi.subtotal)::numeric(12,2) as subtotal,
  o.type
from orders o
join order_items oi on oi.order_id = o.id
join products pr    on pr.id = oi.product_id
where o.type in ('sale', 'sale_return') and o.status = 'confirmed';

-- ----------------------------------------
-- 進出貨明細基底（含成本快照 unit_cost，供報表加總出貨成本）
-- patch-030：納入退貨單，退貨列的 qty、subtotal、折讓分攤為負數，報表合計自然把退貨扣掉。
-- 報表以 flow（sale／purchase）篩選而不是 type：銷貨退回屬 sale 這一側、進貨退出屬 purchase。
-- ----------------------------------------
create or replace view product_movement_base as
select
  oi.product_id,
  o.order_date,
  o.type,
  (abs(oi.qty) * order_amount_sign(o.type)) as qty,
  (order_amount_sign(o.type) * oi.subtotal)::numeric(12,2) as subtotal,
  oi.unit_cost,
  -- 整單折讓掛在單、不掛在商品，按明細小計比例分攤到本列，毛利才不會因忽略折讓而高估。
  -- 保持全精度不 round：同一單各列分攤和恆等於整單折讓，合計不會因逐列進位而漂移。
  -- 整單小計為 0 卻有折讓的異常單以 nullif 防除零，該情況不分攤。
  -- 比例必須用未帶號的 oi.subtotal 算，最後才乘單據正負號（patch-030）：若先把 subtotal 帶成
  -- 負數再套這個式子，分子分母同為負、比例變正，subtotal − alloc 會從應有的 −900 算成 −1100。
  -- 放在最後一欄：create or replace view 只能在尾端追加欄位，插在既有欄位間會報
  -- cannot change name of view column（既有欄的名稱與位置不可變動）。
  order_amount_sign(o.type) * o.discount * oi.subtotal
    / nullif(sum(oi.subtotal) over (partition by oi.order_id), 0) as order_discount_alloc,
  -- patch-026 追加：客戶毛利要按客戶聚合，並算得出「這客戶期間內出了幾張單」。
  o.partner_id,
  o.id as order_id,
  -- patch-030 追加：進出貨方向。報表篩 flow = 'sale'，銷貨退回自動扣掉出貨，不必各處列舉類型。
  case when o.type in ('sale', 'sale_return') then 'sale' else 'purchase' end as flow
from orders o
join order_items oi on oi.order_id = o.id
where o.status = 'confirmed'
  and o.type in ('purchase', 'sale', 'sale_return', 'purchase_return');

-- ============================================================
-- 3. 函式
-- ============================================================

-- 截至某日的累計進貨加權平均。無已確認進貨時回 null，交呼叫端 fallback。
-- 計入進貨退出（patch-030）：Σ帶正負號金額 ÷ Σ帶正負號數量，全部退光時分母為 0 回 null。
-- subtotal 是 abs(qty) 算出的生成欄位、恆為正，正負號必須依單據類型補上。
-- 退貨價低於原進價時，差額會攤進剩餘庫存的均價：供應商少退的錢就是剩下那些貨的成本，
-- 這是刻意的，不是 bug。
create or replace function purchase_avg_cost_asof(
  p_product_id uuid,
  p_as_of date
) returns numeric
language sql
stable
security invoker
as $$
  select sum(order_amount_sign(o.type) * oi.subtotal)
         / nullif(sum(order_amount_sign(o.type) * abs(oi.qty)), 0)
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.product_id = p_product_id
    and o.status = 'confirmed'
    and o.type in ('purchase', 'purchase_return')
    and o.order_date <= p_as_of;
$$;

-- 作廢單據（草稿與已確認皆可；庫存自動回沖，因 stock_view 只計 confirmed）
-- patch-030 退貨的兩條限制：
--   - 原單還有有效（未作廢）的退貨單，不可作廢：否則退貨單會懸在一張不存在的原單上，
--     可退數量、成本快照與帳務都對不起來。要作廢原單，先作廢它的退貨單。
--   - 作廢銷貨退回單要檢查庫存：退回的貨可能已經再賣出去，作廢會讓庫存變負數。
--     進貨退出作廢是把貨加回庫存，不需檢查。
-- 先 for update 鎖住再檢查，與 create_return_order 鎖同一列而序列化，
-- 避免「一邊開退貨單、一邊作廢原單」同時成功。
-- 退貨單已被抵扣的，由 guard_order_total_against_allocations 的 ORDER_HAS_ALLOCATIONS 擋下。
create or replace function void_order(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_type   text;
  v_status text;
  v_line   record;
  v_stock  int;
begin
  select type, status into v_type, v_status
  from orders
  where id = p_order_id
  for update;

  if not found or v_status not in ('draft', 'confirmed') then
    raise exception '單據不存在或已作廢，無法作廢';
  end if;

  if exists (
    select 1 from orders r
    where r.return_of_order_id = p_order_id and r.status = 'confirmed'
  ) then
    raise exception 'ORDER_HAS_RETURNS: 此單據已有退貨單，請先作廢退貨單';
  end if;

  if v_type = 'sale_return' and v_status = 'confirmed' then
    for v_line in
      select oi.product_id, sum(oi.qty)::int as return_qty, p.name
      from order_items oi
      join products p on p.id = oi.product_id
      where oi.order_id = p_order_id
      group by oi.product_id, p.name
    loop
      select coalesce(sum(oi.qty), 0) into v_stock
      from order_items oi
      join orders o on o.id = oi.order_id
      where oi.product_id = v_line.product_id
        and o.status = 'confirmed';

      -- v_stock 目前仍含這張退貨單的數量，作廢後會少掉 return_qty。
      if v_stock - v_line.return_qty < 0 then
        raise exception 'RETURN_STOCK_INSUFFICIENT: %（現有 %，作廢需扣回 %）',
          v_line.name, v_stock, v_line.return_qty;
      end if;
    end loop;
  end if;

  update orders set status = 'void' where id = p_order_id;
end $$;

-- 建立退貨單（銷貨退回／進貨退出）：原子建單 + 逐列限額檢查，建立即生效、不開放草稿。
-- 單據類型由原單決定（sale → sale_return、purchase → purchase_return），呼叫端不傳。
-- p_items 範例：[{"item_id":"原單明細 uuid","qty":2,"unit_price":100}]，qty 一律傳正數，
-- 正負號由這裡依類型寫入（銷貨退回 +、進貨退出 −，與庫存流水帳的方向一致）。
-- for update 鎖住原單：避免兩人同時退同一張而超退，也與 void_order 序列化。
-- 檢查的「已退數量」只算未作廢的退貨單；本次各列先寫入再檢查下一列，
-- 所以同一請求裡重複帶同一列也會被累計進去。
-- 進貨退出檢查的是「目前庫存」而非退貨日當時的庫存，與 create_order 的防超賣一致。
-- 明細折扣 % 沿用原單、不可改；unit_cost 沿用原單那一列的成本快照，
-- 毛利才會剛好反向沖回，不因退貨當天均價不同而產生差額。
-- 整單折讓與稅額各自的歷次有效退貨合計不可超過原單：單價上限只管得住明細，
-- 多次退貨仍可能把稅額退得比原單還多。
create or replace function create_return_order(
  p_original_order_id uuid,
  p_items             jsonb,
  p_order_date        date    default current_date,
  p_discount          numeric default 0,
  p_tax               numeric default 0,
  p_note              text    default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_orig        orders%rowtype;
  v_oi          order_items%rowtype;
  v_item        jsonb;
  v_return_id   uuid;
  v_return_type text;
  v_qty_sign    int;
  v_qty         int;
  v_price       numeric;
  v_returned    int;
  v_stock       int;
  v_name        text;
  v_discount    numeric(12,2) := coalesce(p_discount, 0);
  v_tax         numeric(12,2) := coalesce(p_tax, 0);
  v_date        date := coalesce(p_order_date, current_date);
  v_items_total numeric(12,2);
  v_disc_sum    numeric(12,2);
  v_tax_sum     numeric(12,2);
begin
  select * into v_orig
  from orders
  where id = p_original_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_orig.type not in ('sale', 'purchase') or v_orig.status <> 'confirmed' then
    raise exception '只能對已確認的出貨單或進貨單退貨';
  end if;

  if v_orig.partner_id is null then
    raise exception '原單沒有往來對象，無法退貨';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '退貨明細不可為空';
  end if;

  -- 退貨日早於原單會讓作廢檢查與報表的時間序錯亂。
  if v_date < v_orig.order_date then
    raise exception 'RETURN_DATE_INVALID: 退貨日期 % 不可早於原單日期 %', v_date, v_orig.order_date;
  end if;

  if v_discount < 0 or v_tax < 0 then
    raise exception '整單折讓與稅額不可為負數';
  end if;

  if v_orig.type = 'sale' then
    v_return_type := 'sale_return';
    v_qty_sign := 1;
  else
    v_return_type := 'purchase_return';
    v_qty_sign := -1;
  end if;

  insert into orders (order_no, type, status, partner_id, order_date, discount, tax, note, return_of_order_id)
  values (
    'RTN-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4),
    v_return_type, 'confirmed', v_orig.partner_id, v_date, v_discount, v_tax, p_note, v_orig.id
  )
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty   := (v_item->>'qty')::int;
    v_price := (v_item->>'unit_price')::numeric;

    -- item_id 必須屬於這張原單，否則可以拿別張單的明細列來退。
    select * into v_oi
    from order_items
    where id = (v_item->>'item_id')::uuid
      and order_id = v_orig.id;

    if not found then
      raise exception '退貨明細不屬於此原單';
    end if;

    select name into v_name from products where id = v_oi.product_id;

    if v_qty is null or v_qty <= 0 then
      raise exception '退貨數量必須大於 0';
    end if;

    select coalesce(sum(abs(ri.qty)), 0)::int into v_returned
    from order_items ri
    join orders r on r.id = ri.order_id
    where ri.return_of_item_id = v_oi.id
      and r.status = 'confirmed';

    if v_qty > abs(v_oi.qty) - v_returned then
      raise exception 'RETURN_QTY_EXCEEDS: %（原數量 %，已退 %，本次 %）',
        v_name, abs(v_oi.qty), v_returned, v_qty;
    end if;

    if v_price is null or v_price < 0 or v_price > v_oi.unit_price then
      raise exception 'RETURN_PRICE_EXCEEDS: %（退貨單價須介於 0 與原單價 % 之間）',
        v_name, v_oi.unit_price;
    end if;

    if v_return_type = 'purchase_return' then
      select coalesce(sum(oi.qty), 0) into v_stock
      from order_items oi
      join orders o on o.id = oi.order_id
      where oi.product_id = v_oi.product_id
        and o.status = 'confirmed';

      if v_stock < v_qty then
        raise exception 'RETURN_STOCK_INSUFFICIENT: %（現有 %，需退 %）', v_name, v_stock, v_qty;
      end if;
    end if;

    insert into order_items (order_id, product_id, qty, unit_price, discount, unit_cost, return_of_item_id)
    values (v_return_id, v_oi.product_id, v_qty_sign * v_qty, v_price, v_oi.discount, v_oi.unit_cost, v_oi.id);
  end loop;

  -- 退貨單的 order_total 是負數，淨額（未帶號）必須 >= 0，否則會變成「退貨單反而要收錢」。
  select coalesce(sum(subtotal), 0)::numeric(12,2) into v_items_total
  from order_items
  where order_id = v_return_id;

  if v_items_total - v_discount + v_tax < 0 then
    raise exception '退貨單淨額不可為負數（折讓 % 大於明細合計 %）', v_discount, v_items_total;
  end if;

  -- 含本張在內的歷次有效退貨合計。
  select coalesce(sum(r.discount), 0)::numeric(12,2), coalesce(sum(r.tax), 0)::numeric(12,2)
    into v_disc_sum, v_tax_sum
  from orders r
  where r.return_of_order_id = v_orig.id
    and r.status = 'confirmed';

  if v_disc_sum > coalesce(v_orig.discount, 0) then
    raise exception 'RETURN_AMOUNT_EXCEEDS: 整單折讓歷次退貨合計 % 超過原單的 %',
      v_disc_sum, coalesce(v_orig.discount, 0);
  end if;

  if v_tax_sum > coalesce(v_orig.tax, 0) then
    raise exception 'RETURN_AMOUNT_EXCEEDS: 稅額歷次退貨合計 % 超過原單的 %',
      v_tax_sum, coalesce(v_orig.tax, 0);
  end if;

  return v_return_id;
end $$;

-- ----------------------------------------
-- 依組搜尋單據（分批進出貨的合併列表）
-- 各篩選條件套用的層級不同，刻意如此：
--   - 狀態、類型：成員層級，決定組裡「有哪些單」。張數、合計只算通過的成員，
--     預設「有效」時作廢的那批不算進合計，展開也看不到。
--   - 日期、關鍵字：組內任一批命中就整組列出。分批常跨月，搜 B 才有的商品也要找得到這組。
--   - 付款狀態：套在組推導後的狀態。篩「未結清」是要找整批還欠多少，
--     A 已付、B 未付的組是「部分付款」，必須被列入；逐張比對會讓結果與列上顯示的狀態不一致。
-- 組付款狀態：組內沒有已確認的進出貨單 → null；一毛未付 → unpaid；未付為 0 → paid；其餘 partial。
-- 比較一律用絕對值（patch-030）：退貨單的已付、未付都是負數，用 <= 0 會讓退貨單永遠「未抵扣」。
-- 退貨單的 parent_order_id 為 null，自己獨立成一組，不會被併進原單那一組的合計。
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
        when abs(g.paid_amount) = 0         then 'unpaid'
        when abs(g.outstanding_amount) = 0  then 'paid'
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

-- 原子儲存收付款 + 逐單分配（取代前端三段式呼叫，任一段失敗都會留下不一致資料）。
-- 單號一律在 DB 端產生，避免前端併發產生重號。
-- 對象為客戶即收款、為供應商即付款（patch-027），方向不另傳參數，由對象類型決定。
-- patch-030：金額允許 0（0 元沖帳單：換貨時退貨剛好抵掉出貨、沒有現金進出），
-- 但 0 元收款一定要有分配、且淨額為 0，不開放「無分配的 0 元收款」（那只是一筆沒有意義的空紀錄）。
-- 無分配的情況沒有 payment_orders 列可以觸發 constraint trigger，所以這裡要先擋；
-- 淨額是否為 0 則在 commit 時由 trigger 依實際分配驗證。
-- 分配金額改為只擋 0：退貨單的分配是負數。
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

  if p_amount is null or p_amount < 0 then
    raise exception 'PAYMENT_AMOUNT_INVALID';
  end if;

  if p_amount = 0 and jsonb_array_length(coalesce(p_allocations, '[]'::jsonb)) = 0 then
    raise exception 'PAYMENT_AMOUNT_INVALID: 0 元收付款必須有分配（以退貨抵扣出貨）';
  end if;

  if p_method not in ('cash', 'transfer', 'check') then
    raise exception 'PAYMENT_METHOD_INVALID: %', p_method;
  end if;

  select true into v_partner_ok
  from partners
  where id = p_partner_id and type in ('customer', 'supplier');

  if not found then
    raise exception 'PAYMENT_PARTNER_INVALID: 找不到此往來對象';
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

    if v_alloc.amount is null or v_alloc.amount = 0 then
      raise exception 'ALLOCATION_AMOUNT_INVALID';
    end if;

    insert into payment_orders (payment_id, order_id, amount)
    values (v_payment_id, v_alloc.order_id, v_alloc.amount);
  end loop;

  -- 交易 commit 時，constraint trigger 會驗證：
  --   1. 0 <= 分配淨額 <= 收款金額（退貨單的分配為負數，淨額 < 0 即 ALLOCATION_NET_NEGATIVE）
  --   2. 每張單分配總額的絕對值 <= 單據金額的絕對值，且正負號與單據一致
  --   3. 收付款對象 = 單據對象
  --   4. 只能沖已確認的出貨單／進貨單／退貨單，且方向相符（客戶沖出貨與銷貨退回、供應商沖進貨與進貨退出）
  --   5. 收款金額為 0 時，分配必須非空且淨額恰為 0
  return v_payment_id;
end $$;

-- 單筆收付款的分配淨額規則（patch-030）：0 <= 淨額 <= 收款金額；收款金額為 0 時，分配必須非空且淨額恰為 0。
--   - 淨額 < 0 → ALLOCATION_NET_NEGATIVE：退貨抵超過出貨，多出來的負數無處可去。
--   - 收款金額 > 淨額的差額照既有規則列為預收，不另外擋。
--   - 0 元收款不開放「無分配」：那只是一筆沒有意義的空紀錄。
-- 抽成獨立函式，讓 payment_orders 與 payments 兩邊的 constraint trigger 共用同一份規則：
-- 只掛 payment_orders 的話，直接 PATCH payments.amount 成 0（沒有任何分配列）不會觸發驗證。
-- 收款可能在同一交易被刪除（例如 on delete cascade），此時無需驗證。
create or replace function assert_payment_allocation_net(p_payment_id uuid)
returns void
language plpgsql
as $$
declare
  v_amount numeric(12,2);
  v_net    numeric(12,2);
  v_count  int;
begin
  select pay.amount into v_amount from payments pay where pay.id = p_payment_id;

  if not found then
    return;
  end if;

  select coalesce(sum(po.amount), 0)::numeric(12,2), count(*)
    into v_net, v_count
  from payment_orders po
  where po.payment_id = p_payment_id;

  if v_amount = 0 and (v_count = 0 or v_net <> 0) then
    raise exception 'PAYMENT_AMOUNT_INVALID: 0 元收付款的分配必須非空且淨額為 0（目前 % 筆、淨額 %）',
      v_count, v_net;
  end if;

  if v_net < 0 then
    raise exception 'ALLOCATION_NET_NEGATIVE: 分配淨額 % 小於 0，退貨抵扣超過所選出貨／進貨金額', v_net;
  end if;

  if v_net > v_amount then
    raise exception 'ALLOCATION_EXCEEDS_PAYMENT: 分配總額 % 超過收款金額 %', v_net, v_amount;
  end if;
end;
$$;

-- 跨列總額驗證（check constraint 不能跨列聚合，只能用 trigger）。
-- 搭配 constraint trigger + deferrable initially deferred，讓 RPC 能在同一交易內
-- 「先刪光舊分配、再插入新分配」，到 commit 才驗證，中間暫態不會被誤判。
-- patch-030：可沖退貨單。分配的正負號與單據金額一致（退貨單為負），
-- 絕對值不可超過單據金額；單筆收款的淨額規則見 assert_payment_allocation_net。
create or replace function validate_payment_order_allocations()
returns trigger
language plpgsql
as $$
declare
  v_payment_id        uuid;
  v_order_id          uuid;
  v_payment_partner   uuid;
  v_partner_type      text;
  v_order_total       numeric(12,2);
  v_order_partner     uuid;
  v_order_type        text;
  v_order_status      text;
  v_order_allocated   numeric(12,2);
begin
  v_payment_id := coalesce(new.payment_id, old.payment_id);
  v_order_id   := coalesce(new.order_id,   old.order_id);

  perform assert_payment_allocation_net(v_payment_id);

  select pay.partner_id, pt.type
    into v_payment_partner, v_partner_type
  from payments pay
  left join partners pt on pt.id = pay.partner_id
  where pay.id = v_payment_id;

  select order_total, partner_id, type, status
    into v_order_total, v_order_partner, v_order_type, v_order_status
  from order_total_view
  where order_id = v_order_id;

  if found then
    if v_order_type not in ('sale', 'purchase', 'sale_return', 'purchase_return')
       or v_order_status <> 'confirmed' then
      raise exception 'ALLOCATION_TARGET_INVALID: 只能沖帳已確認的出貨單、進貨單或退貨單';
    end if;

    -- 對象一致性只擋得住「單據 partner_id 不同」；單據沒掛對象（partner_id 為 null）時
    -- 會放行，因此方向要另外驗：客戶的收款沖進貨單會讓應付憑空被「收」掉。
    -- 退貨單跟著原單方向：銷貨退回屬客戶、進貨退出屬供應商。
    if v_partner_type is not null
       and (v_partner_type = 'customer') <> (v_order_type in ('sale', 'sale_return')) then
      raise exception 'ALLOCATION_DIRECTION_MISMATCH: 客戶只能沖出貨單與銷貨退回、供應商只能沖進貨單與進貨退出';
    end if;

    select coalesce(sum(amount), 0)::numeric(12,2)
      into v_order_allocated
    from payment_orders
    where order_id = v_order_id;

    if abs(v_order_allocated) > abs(v_order_total) then
      raise exception 'ALLOCATION_EXCEEDS_ORDER: 單據分配總額 % 超過單據金額 %',
        v_order_allocated, v_order_total;
    end if;

    -- 分配方向要與單據一致：出貨單的分配為正、退貨單為負。
    -- 否則在出貨單上放負的分配，淨額規則會被繞過去（用負數把別張單的分配「抵」回來）。
    if exists (
      select 1 from payment_orders
      where order_id = v_order_id
        and sign(amount) <> sign(v_order_total)
    ) then
      raise exception 'ALLOCATION_AMOUNT_INVALID: 分配金額的正負號必須與單據金額一致（單據金額 %）',
        v_order_total;
    end if;

    if v_payment_partner is not null
       and v_order_partner is not null
       and v_payment_partner <> v_order_partner then
      raise exception 'ALLOCATION_PARTNER_MISMATCH: 收付款對象與單據對象不一致';
    end if;
  end if;

  return null;
end;
$$;

-- payments 端的 constraint trigger：只為補 payment_orders trigger 觸發不到的路徑
-- （改 payments.amount、0 元收款完全沒有分配列），規則同 assert_payment_allocation_net。
create or replace function validate_payment_amount()
returns trigger
language plpgsql
as $$
begin
  perform assert_payment_allocation_net(new.id);
  return null;
end;
$$;

-- 保護既有單據不被改成低於已收金額（以 trigger 兜底 update_order_meta 之外的路徑）。
-- patch-030：金額比較改用絕對值。退貨單的已沖金額是負數，單據金額這裡自己從 subtotal 算、
-- 未帶號（恆為正），兩邊各取絕對值才是「金額是否小於已沖」的同一個比較。
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

  if abs(v_new_total) < abs(v_allocated) then
    raise exception 'ORDER_TOTAL_BELOW_ALLOCATED: 單據金額 % 低於已收款 %',
      abs(v_new_total), abs(v_allocated);
  end if;

  return new;
end;
$$;

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
    coalesce(sum(m.qty)      filter (where m.flow = 'purchase'), 0),
    -- 進/出貨金額扣掉分攤到本列的整單折讓（未稅、含折讓）；數量與成本快照不受折讓影響。
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.flow = 'purchase'), 0),
    coalesce(sum(m.qty)      filter (where m.flow = 'sale'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.flow = 'sale'), 0),
    coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.flow = 'sale'), 0)
  from product_movement_base m
  where m.order_date between p_from and p_to
  group by m.product_id;
$$;

-- 期間損益彙總（含稅檢視用；總覽卡片已改走 product_cost_analysis_summary 的全未稅口徑）
-- patch-030：revenue／expense 計入退貨單（負數）。order_totals 是自己從 subtotal 算、
-- 不讀 order_total_view，而 subtotal 恆為正，所以正負號要在這裡另外乘上，不會自動帶進來。
-- 收益／支出 = 明細小計 − 整單折讓 + 稅額（含稅，收付視角）；
-- 成本 = Σ 各商品出貨成本快照；
-- 毛利 = 未稅銷貨淨額（含折讓）− 成本。稅是代收代付、不是收入，故毛利一律未稅，
--        不可用含稅的 revenue 去減成本（那會讓毛利被稅額灌水）。
-- 回傳欄位新增 profit，型別變動，必須先 drop 再 create（create or replace 不允許改回傳型別）。
create or replace function dashboard_summary(
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
      order_amount_sign(o.type) * (coalesce(sum(oi.subtotal), 0) - o.discount + o.tax) as net_amount
    from orders o
    left join order_items oi on oi.order_id = o.id
    where o.status = 'confirmed'
      and o.type in ('purchase', 'sale', 'sale_return', 'purchase_return')
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
    coalesce(sum(net_amount) filter (where type in ('sale', 'sale_return')), 0),
    coalesce(sum(net_amount) filter (where type in ('purchase', 'purchase_return')), 0),
    (select cost from movement),
    (select sale_net - cost from movement)
  from order_totals;
$$;

-- 單一商品的期間彙總（供商品頁毛利與「平均出貨成本」卡）
-- 改由 product_movement_base 取數，與總覽的成本分析同口徑：金額含整單折讓、未稅。
-- cost = Σ(出貨明細 unit_cost × qty)，成本快照不受折讓影響。調整單本就不在該 view。
-- patch-030：qty 在 view 內已帶號，銷貨退回沿用原出貨列的 unit_cost，成本因此剛好反向沖回。
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
    coalesce(sum(m.qty) filter (where m.flow = 'purchase'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.flow = 'purchase'), 0),
    coalesce(sum(m.qty) filter (where m.flow = 'sale'), 0),
    coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.flow = 'sale'), 0),
    coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.flow = 'sale'), 0)
  from product_movement_base m
  where m.product_id = p_product_id
    and (p_from is null or m.order_date >= p_from)
    and (p_to   is null or m.order_date <= p_to);
$$;

-- 單一商品的期間進出明細（供前端分頁）
-- 這裡「不」過濾 type：調整單也要顯示，讓使用者看得到庫存被校正過。
-- qty 本就帶號（退貨單依類型寫入）；subtotal 恆為正，退貨列改輸出負數，與 product_movement_base 同口徑。
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
    (order_amount_sign(o.type) * oi.subtotal)::numeric(12,2)
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.product_id = p_product_id
    and o.status = 'confirmed'
    and (p_from is null or o.order_date >= p_from)
    and (p_to   is null or o.order_date <= p_to)
  order by o.order_date desc, o.order_no desc, oi.id desc;
$$;

-- 客戶應收／供應商應付餘額（截至指定日期、可依對象或關鍵字篩選、由前端分頁）
-- 口徑選「期末快照」而非「期間發生額」：積欠但近期沒下單的客戶餘額才不會顯示 0。
-- 三個 CTE 的截止日必須一致，只截其中一側會讓 unallocated_credit 變負數。
-- p_partner_id / p_keyword 凌駕 p_include_settled：明確指定就必須看得到，即使已結清。
-- patch-030：總額納入退貨單（帶負號），退貨在退貨日那一期直接減掉應收／應付。
-- p_partner_type（patch-027）：'supplier' 時改算進貨單與付款＝應付。回傳欄位名稱沿用
-- total_sales（此時代表進貨總額）、total_paid（已付）不改名，既有呼叫端才不必跟著改。
-- 加參數必須先 drop：create or replace 會留下舊的 4 參數版成為重載，具名呼叫時 ambiguous。
create or replace function get_partner_balances(
  p_as_of date default null,
  p_partner_id uuid default null,
  p_include_settled boolean default false,
  p_keyword text default null,
  p_partner_type text default 'customer'
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
    where ot.type = any (case when p_partner_type = 'supplier'
                              then array['purchase', 'purchase_return']
                              else array['sale', 'sale_return'] end)
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
  where p.type = p_partner_type
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
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.flow = 'purchase'), 0) as purchase_amount,
      coalesce(sum(m.subtotal - coalesce(m.order_discount_alloc, 0)) filter (where m.flow = 'sale'), 0)     as sale_amount,
      coalesce(sum(coalesce(m.unit_cost, 0) * m.qty) filter (where m.flow = 'sale'), 0) as cost
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

-- 逐客戶毛利（一客戶一列；排序與分頁交給前端，同 product_cost_analysis）
-- 只回期間內有出貨或退貨的客戶：沒出貨也沒退貨就沒有毛利可談，列出來只是一堆 0。
-- patch-030：銷貨退回（flow = 'sale'）以負數併入收益與成本，毛利剛好反向沖回；
-- 只有退貨、沒有出貨的客戶會以負毛利出現在清單——保留，因為那就是該期的真實毛利。
-- order_count、last_sale_date 仍只算 type = 'sale'，否則「最後出貨日」會變成退貨日。
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
      count(distinct m.order_id) filter (where m.type = 'sale')            as order_count,
      max(m.order_date)          filter (where m.type = 'sale')            as last_sale_date,
      coalesce(sum(m.qty) filter (where m.unit_cost is null), 0)           as no_cost_qty
    from product_movement_base m
    where m.flow = 'sale'
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
  where m.flow = 'sale'
    and m.partner_id = p_partner_id
    and (p_from is null or m.order_date >= p_from)
    and (p_to   is null or m.order_date <= p_to)
  group by pr.id, pr.sku, pr.name, pr.unit;
$$;

-- ============================================================
-- 4. Trigger
-- ============================================================
-- 同樣 deferred：RPC 先寫 payments 再寫 payment_orders，commit 才驗證。
drop trigger if exists payments_validate_amount on payments;
create constraint trigger payments_validate_amount
  after insert or update of amount on payments
  deferrable initially deferred
  for each row
  execute function validate_payment_amount();

commit;
