-- patch-028-order-parent
-- 分批進出貨：單據可「接續原單」，同一批訂貨的多張單歸為一組
--
-- 背景：供應商常分批補貨，使用者想把後到的貨追加到原進貨單。但已確認單不能追加明細——
-- 庫存、as-of 均價、月報都以 orders.order_date 為時間軸，出貨成本又在確認當下寫死，
-- 10/15 到的貨記在 10/1 的單上，會讓這段期間的庫存與已寫定的出貨成本事後對不起來。
--
-- 設計：每批照常開一張新單（庫存、成本、報表口徑都不變），新單以 parent_order_id 指向原單。
-- 群組鍵＝coalesce(parent_order_id, id)。只允許兩層（原單 ← 接續單）：
--   - 群組查詢不需遞迴，也不可能出現循環。
--   - 不允許接續「接續單」，也不允許已有接續單的原單再去接續別人。
-- 原單須同類型（進貨或出貨）、同往來對象、已確認。原單狀態只在「設定／變更接續」當下檢查，
-- 原單事後作廢不連帶影響接續單，否則接續單連備註都改不了。
--
-- 規則寫在 trigger 而非各支 RPC：create_order／update_draft_order／set_order_parent
-- 與直接 PATCH 都會經過，不必在四個地方各寫一份、改一邊漏另一邊。
--
-- 整份可重複執行。create_order／update_draft_order 加參數，必須先 drop 舊簽名，
-- 否則 create or replace 會留下舊版成為重載，具名呼叫時 ambiguous。

alter table orders add column if not exists parent_order_id uuid references orders(id);

comment on column orders.parent_order_id is
  '接續的原單（分批進出貨）。只允許兩層，群組鍵為 coalesce(parent_order_id, id)。見 guard_order_parent。';

create index if not exists idx_orders_parent
  on orders (parent_order_id)
  where parent_order_id is not null;

-- ----------------------------------------
-- 接續原單的規則
-- ----------------------------------------
create or replace function guard_order_parent()
returns trigger
language plpgsql
as $$
declare
  v_parent orders%rowtype;
begin
  if new.parent_order_id is null then
    return new;
  end if;

  if new.parent_order_id = new.id then
    raise exception 'ORDER_PARENT_INVALID: 單據不能接續自己';
  end if;

  if new.type not in ('sale', 'purchase') then
    raise exception 'ORDER_PARENT_INVALID: 只有進貨單與出貨單可以接續原單';
  end if;

  select * into v_parent from orders where id = new.parent_order_id;

  if not found then
    raise exception 'ORDER_PARENT_INVALID: 找不到要接續的原單';
  end if;

  if v_parent.parent_order_id is not null then
    raise exception 'ORDER_PARENT_NESTED: % 本身是接續單，請改接續它的原單', v_parent.order_no;
  end if;

  -- 草稿換往來對象也會走到這裡：接續單必須與原單同對象，付款時才能一起沖帳。
  if v_parent.type <> new.type
     or v_parent.partner_id is distinct from new.partner_id then
    raise exception 'ORDER_PARENT_INVALID: 只能接續同類型、同往來對象的單據（%）', v_parent.order_no;
  end if;

  -- 只在設定／變更接續的當下檢查原單狀態：原單事後作廢，接續單仍要能改備註、確認草稿。
  if (tg_op = 'INSERT' or new.parent_order_id is distinct from old.parent_order_id)
     and v_parent.status <> 'confirmed' then
    raise exception 'ORDER_PARENT_INVALID: 只能接續已確認的單據（%）', v_parent.order_no;
  end if;

  if exists (select 1 from orders where parent_order_id = new.id) then
    raise exception 'ORDER_HAS_CHILDREN: 此單已有接續單，不能再接續其他單';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_guard_parent on orders;
create trigger orders_guard_parent
  before insert or update of parent_order_id, partner_id, type on orders
  for each row
  execute function guard_order_parent();

-- ----------------------------------------
-- 建單（原子性 + 防超賣；確認當下寫定成本快照）
-- p_items 範例：[{"product_id":"uuid","qty":3,"unit_price":100,"discount":0}]
-- ----------------------------------------
drop function if exists create_order(text, uuid, text, jsonb, date, numeric, numeric, text);
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

  insert into orders (order_no, type, status, partner_id, order_date, discount, tax, note, parent_order_id)
  values (
    'ORD-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4),
    p_type, p_status, p_partner, p_order_date, p_discount, p_tax, p_note, p_parent_order_id
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

-- ----------------------------------------
-- 編輯草稿單（整張替換 header + 明細）
-- 已確認/作廢不可經此修改；type 一律鎖定，改型別應作廢重開。
-- ----------------------------------------
drop function if exists update_draft_order(uuid, uuid, text, jsonb, date, numeric, numeric);
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

-- ----------------------------------------
-- 設定／解除接續原單（已確認單事後補設用；草稿走 update_draft_order）
-- 不併進 update_order_meta：那裡的 null 代表「不改」，表達不了「解除接續」。
-- ----------------------------------------
create or replace function set_order_parent(
  p_order_id        uuid,
  p_parent_order_id uuid
) returns void
language plpgsql
security invoker
as $$
declare
  v_status text;
begin
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
  set parent_order_id = p_parent_order_id
  where id = p_order_id;
end $$;

-- ----------------------------------------
-- 單據搜尋（時間區間 + 關鍵字）
-- payment_status 讀推導值；total_amount 為淨額（小計 − 折讓 + 稅），
-- 與付款狀態、partner_balance_view、dashboard_summary 同口徑。
-- item_count 仍在這裡自己 count：這裡是 left join orders，沒有明細的單要算 0，
-- 而 order_top_item_view 根本不會有那一列。
-- search_text 併入原單單號（patch-028）：搜原單號就能撈出整組。
-- 群組欄位只能追加在尾端：create or replace view 不能調整既有欄位順序。
-- group_size 不計作廢單：作廢的那批貨已經不存在，算進去會讓「共 N 批」對不上實際張數。
-- ----------------------------------------
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
    when o.type in ('sale', 'purchase') and o.status = 'confirmed'
      then coalesce(ops.payment_status, 'unpaid')
    else null
  end as payment_status,
  ops.paid_amount,
  ops.outstanding_amount,
  o.order_no || ' ' || coalesce(o.note,'')
    || ' ' || coalesce(p.name,'') || ' ' || coalesce(p.tax_id,'')
    || ' ' || coalesce(string_agg(pr.name || ' ' || pr.sku, ' '), '')
    || ' ' || coalesce((select r.order_no from orders r where r.id = o.parent_order_id), '')
    as search_text,
  ti.top_item_name,
  o.parent_order_id,
  coalesce(o.parent_order_id, o.id) as group_root_id,
  (select r.order_no from orders r where r.id = coalesce(o.parent_order_id, o.id)) as group_root_no,
  (select count(*) from orders g
    where (g.id = coalesce(o.parent_order_id, o.id)
           or g.parent_order_id = coalesce(o.parent_order_id, o.id))
      and g.status <> 'void') as group_size
from orders o
left join partners p     on p.id = o.partner_id
left join order_items oi on oi.order_id = o.id
left join products pr    on pr.id = oi.product_id
left join order_payment_summary_view ops on ops.order_id = o.id
left join order_top_item_view ti on ti.order_id = o.id
group by o.id, p.name, p.tax_id,
         ops.payment_status, ops.paid_amount, ops.outstanding_amount,
         ti.top_item_name;
