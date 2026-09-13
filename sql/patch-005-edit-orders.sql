-- ============================================================
-- Patch 005：單據編輯
-- 適用：已執行過 migration.sql + patch-001~004 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 可編輯範圍（刻意限制，以維持流水帳的可追溯性）：
--   草稿  ：往來對象、日期、折讓、稅額、備註、明細（整批替換）
--   已確認：僅備註與付款狀態
--   已作廢：不可編輯
--
-- 單據類型（type）一律鎖定：切換 purchase/sale 會翻轉所有明細的
-- 正負號語意，改型別應作廢重開而非就地修改。
--
-- 已確認單據不開放修改日期：order_date 決定該筆落在哪個對帳期間，
-- 變更會連帶改寫對帳單的期前餘額，等同重寫歷史報表。

-- ============================================
-- RPC：編輯草稿單（整張替換 header + 明細）
-- ============================================
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
  -- 鎖定該列並重查狀態：確保與 confirm_order / void_order 序列化，
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

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception '單據明細不可為空';
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

-- ============================================
-- RPC：編輯單據備註與付款狀態
-- 草稿與已確認皆可用；已作廢不可編輯。
-- 收斂為 RPC 而非直接 update 資料表，避免規則被繞過。
-- ============================================
create or replace function update_order_meta(
  p_order_id uuid,
  p_note text default null,
  p_payment_status text default null
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

  if p_payment_status is not null
     and p_payment_status not in ('unpaid','partial','paid') then
    raise exception '無效的付款狀態: %', p_payment_status;
  end if;

  update orders
  set note           = coalesce(p_note, note),
      payment_status = coalesce(p_payment_status, payment_status)
  where id = p_order_id;
end $$;
