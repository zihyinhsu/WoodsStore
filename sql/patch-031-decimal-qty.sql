-- patch-031-decimal-qty
-- 數量改為可帶兩位小數：order_items.qty 由 int 改為 numeric(12,2)。
--
-- 為什麼：地板、石材以「坪」計價，一件 0.42 坪，12 件就是 5.04 坪；整數數量記不了。
-- 庫存（stock_view）是 order_items.qty 的加總，所以庫存也一併變成可帶小數。
--
-- 動 SQL 前必須知道的事：
--   - qty 被生成欄位 subtotal 引用，Postgres 不允許改型別（cannot alter type of a column used by
--     a generated column），只能先 drop subtotal、改 qty、再以同一條算式加回。
--     加回的 subtotal 會排到最後一欄；沒有地方依賴欄位順序（insert 都有列欄名、%rowtype 執行期才解析）。
--   - drop subtotal 之前，引用 order_items 的 13 個 view（含層層往上依賴的）都得先 drop。
--     這裡不把 view 定義抄一份，而是從資料庫當下的定義（pg_get_viewdef）存起來、改完再照原樣重建，
--     連同 reloptions 與 grant：抄寫一份容易和正式庫實際定義有出入，重建出舊版 view 卻不會報錯。
--   - 報表函式的回傳欄位 bigint／int 改 numeric，create or replace 不允許改回傳型別，必須 drop 再 create。
--     這些函式的呼叫端（dashboard_summary、cost_ranking、partner_profit_ranking 等）都是 language sql
--     的晚綁定，不會被連帶 drop，也不用改。
--   - RPC 解析數量改為 round((qty)::numeric, 2)：與欄位精度一致，防超賣與可退數量檢查
--     比對的是實際寫入的值。
--   - products.safety_stock 維持 int：安全庫存是門檻，numeric 與 int 比較沒有問題。
--
-- 整份在一個交易內，任何一步失敗都會整個 rollback。改完欄位型別需要重寫整張 order_items。

begin;

-- ============================================================
-- 1. 暫存並 drop 依賴 order_items 的 view
-- ============================================================
-- lvl 取最大值：同一個 view 可能經由不同路徑依賴，重建時必須排在它所有依賴之後。
create temp table _qty_views on commit drop as
with recursive deps(oid, lvl) as (
  select distinct r.ev_class, 1
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid
  where d.refobjid = 'public.order_items'::regclass
    and r.ev_class <> 'public.order_items'::regclass
  union
  select r.ev_class, deps.lvl + 1
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid
  join deps on d.refobjid = deps.oid
  where r.ev_class <> deps.oid
)
select c.oid::bigint as old_oid,
       c.relname::text as relname,
       max(deps.lvl) as lvl,
       pg_get_viewdef(c.oid) as viewdef,
       c.reloptions,
       c.relacl,
       obj_description(c.oid, 'pg_class') as descr
from deps
join pg_class c on c.oid = deps.oid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
group by c.oid;

do $$
declare
  v record;
begin
  if exists (select 1 from _qty_views where relname not in (
    'stock_view', 'low_stock_view', 'order_total_view', 'order_payment_summary_view',
    'outstanding_order_view', 'unpaid_order_view', 'order_top_item_view', 'order_search_view',
    'partner_balance_view', 'statement_line_view', 'product_movement_base',
    'payment_search_view', 'payment_allocation_view'
  )) or (select count(*) from _qty_views) <> 13 then
    -- 名單與 dev 實測不同代表正式庫結構和預期有出入，先停下來人工確認，不要盲目重建。
    raise exception '依賴 order_items 的 view 與預期不符：%',
      (select string_agg(relname, ', ' order by relname) from _qty_views);
  end if;

  for v in select relname from _qty_views order by lvl desc, relname loop
    execute format('drop view public.%I', v.relname);
  end loop;
end $$;

-- ============================================================
-- 2. 改欄位型別
-- ============================================================
alter table order_items drop column subtotal;
alter table order_items alter column qty type numeric(12,2);
alter table order_items add column subtotal numeric(12,2)
  generated always as (abs(qty) * unit_price * (1 - discount/100)) stored;

-- ============================================================
-- 3. 照原樣重建 view（定義、reloptions、grant、註解）
-- ============================================================
do $$
declare
  v record;
  g record;
begin
  for v in select * from _qty_views order by lvl, relname loop
    execute format('create view public.%I%s as %s',
      v.relname,
      case when v.reloptions is null then ''
           else ' with (' || array_to_string(v.reloptions, ', ') || ')' end,
      v.viewdef);

    if v.descr is not null then
      execute format('comment on view public.%I is %L', v.relname, v.descr);
    end if;

    -- 只還原原本的 grant，不靠 default privileges：正式庫與 dev 的預設權限不保證一樣。
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v.relname);
    for g in
      select a.privilege_type, a.grantee
      from aclexplode(v.relacl) a
    loop
      execute format('grant %s on public.%I to %s',
        g.privilege_type, v.relname,
        case when g.grantee = 0 then 'public' else quote_ident(g.grantee::regrole::text) end);
    end loop;
  end loop;
end $$;

-- ============================================================
-- 4. 單據 RPC：數量以 numeric 解析（簽名不變，create or replace）
-- ============================================================

create or replace function create_order(
  p_type text,
  p_partner uuid,
  p_note text,
  p_items jsonb,
  p_order_date date default current_date,
  p_discount numeric default 0,
  p_tax numeric default 0,
  p_status text default 'confirmed',
  p_parent_order_id uuid default null
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_order_id uuid;
  v_item jsonb;
  v_sign int := case when p_type = 'purchase' then 1 else -1 end;
  v_stock numeric;
  v_qty numeric;
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

  insert into orders (order_no, type, status, partner_id, order_date, discount, tax, note, parent_order_id)
  values (
    'ORD-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4),
    p_type, p_status, p_partner, p_order_date, p_discount, p_tax, p_note, p_parent_order_id
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := round((v_item->>'qty')::numeric, 2);

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

create or replace function confirm_order(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_item record;
  v_stock numeric;
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

create or replace function void_order(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_type   text;
  v_status text;
  v_line   record;
  v_stock  numeric;
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
      select oi.product_id, sum(oi.qty) as return_qty, p.name
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
  v_qty         numeric;
  v_price       numeric;
  v_returned    numeric;
  v_stock       numeric;
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
    v_qty   := round((v_item->>'qty')::numeric, 2);
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

    select coalesce(sum(abs(ri.qty)), 0) into v_returned
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

create or replace function update_draft_order(
  p_order_id uuid,
  p_partner uuid,
  p_note text,
  p_items jsonb,
  p_order_date date,
  p_discount numeric default 0,
  p_tax numeric default 0,
  p_parent_order_id uuid default null
) returns void
language plpgsql
security invoker
as $$
declare
  v_type text;
  v_status text;
  v_item jsonb;
  v_qty numeric;
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
  set partner_id      = p_partner,
      note            = p_note,
      order_date      = coalesce(p_order_date, order_date),
      discount        = coalesce(p_discount, 0),
      tax             = coalesce(p_tax, 0),
      parent_order_id = p_parent_order_id
  where id = p_order_id;

  delete from order_items where order_id = p_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product    := (v_item->>'product_id')::uuid;
    v_qty        := round((v_item->>'qty')::numeric, 2);
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

-- ============================================================
-- 5. 報表 RPC：數量回傳型別 bigint／int → numeric（必須 drop 再 create）
-- ============================================================

drop function if exists product_movement(date, date);
create function product_movement(
  p_from date,
  p_to date
) returns table (
  product_id uuid,
  purchase_qty numeric,
  purchase_amount numeric,
  sale_qty numeric,
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

drop function if exists product_cost_analysis(date, date, boolean);
create function product_cost_analysis(
  p_from date,
  p_to date,
  p_with_movement_only boolean default false
) returns table (
  product_id uuid,
  sku text,
  name text,
  unit text,
  purchase_qty numeric,
  purchase_amount numeric,
  sale_qty numeric,
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

drop function if exists product_cost_detail_summary(uuid, date, date);
create function product_cost_detail_summary(
  p_product_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  purchase_qty numeric,
  purchase_amount numeric,
  sale_qty numeric,
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

drop function if exists product_cost_movements(uuid, date, date);
create function product_cost_movements(
  p_product_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  item_id uuid,
  order_no text,
  order_date date,
  type text,
  qty numeric,
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

drop function if exists partner_profit(date, date, text, uuid);
create function partner_profit(
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
  no_cost_qty numeric
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

drop function if exists partner_profit_products(uuid, date, date);
create function partner_profit_products(
  p_partner_id uuid,
  p_from date default null,
  p_to date default null
) returns table (
  product_id uuid,
  sku text,
  name text,
  unit text,
  sale_qty numeric,
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
    sum(m.qty),
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
-- 6. 驗證
-- ============================================================
do $$
begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'order_items' and column_name = 'qty') <> 'numeric' then
    raise exception 'order_items.qty 未改成 numeric';
  end if;
  if (select count(*) from pg_views v join _qty_views q on q.relname = v.viewname
      where v.schemaname = 'public') <> 13 then
    raise exception 'view 未全部重建';
  end if;
end $$;

-- 讓 PostgREST 立即重讀 schema，否則前端在快取過期前仍會拿到舊的回傳型別。
notify pgrst, 'reload schema';

commit;
