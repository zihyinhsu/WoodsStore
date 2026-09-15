-- ============================================================
-- Patch 019：成本快照寫入路徑（Stage 2）
-- 適用：已執行過 patch-018 的資料庫（依賴 snapshot_order_item_costs）
-- 使用方式：整份貼到 Supabase SQL Editor → Run
--
-- 建單／確認時把成本寫定，讓 patch-018 的 backfill 之後所有新單都自帶快照。
--   create_order(p_status='confirmed')：新確認單當下寫定。
--   confirm_order：草稿轉確認的當下才寫定（草稿不佔庫存、也不定成本）。
--   update_draft_order：不動——草稿沒有快照，改到確認才定，故本 patch 不碰它。
--
-- 兩支都改成呼叫 snapshot_order_item_costs()，與 backfill 共用同一套口徑，
-- 不在這裡重寫一份 as-of 均價公式，避免日後改一邊漏一邊。
-- ============================================================

-- ============================================
-- RPC：建立單據（沿用 patch-001 版本，僅在確認時補寫成本快照）
-- ============================================
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
  -- 放在迴圈後：此時 subtotal（generated column）已算好，直接反推進貨實付單價。
  if p_status = 'confirmed' then
    perform snapshot_order_item_costs(v_order_id);
  end if;

  return v_order_id;
end $$;

-- ============================================
-- RPC：確認草稿單（防超賣檢查通過後寫定成本快照）
-- ============================================
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
