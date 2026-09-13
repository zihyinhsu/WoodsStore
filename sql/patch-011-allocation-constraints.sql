-- ============================================================
-- Patch 011：分配金額約束 + 原子儲存 RPC
-- 適用：已執行過 patch-010 且三個檢查查詢皆為空的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 執行前務必確認 patch-010 的檢查 1~3 都沒有回傳任何列，
-- 否則 NOT NULL 或 trigger 會因既有髒資料而失敗。
-- ============================================================

-- ============================================
-- 收緊欄位
-- ============================================
alter table payment_orders
  alter column amount set not null;

alter table payment_orders
  drop constraint if exists payment_orders_amount_positive;

alter table payment_orders
  add constraint payment_orders_amount_positive check (amount > 0);

-- ============================================
-- 跨列總額驗證
-- Postgres 的 check constraint 不能跨列聚合，只能用 trigger。
-- 用 constraint trigger + deferrable initially deferred，
-- 讓 RPC 能在同一交易內「先刪光舊分配、再插入新分配」，
-- 到 commit 時才驗證，中間的暫時狀態不會被誤判。
-- ============================================
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

drop trigger if exists payment_orders_validate_allocations on payment_orders;

create constraint trigger payment_orders_validate_allocations
after insert or update or delete on payment_orders
deferrable initially deferred
for each row
execute function validate_payment_order_allocations();

-- ============================================
-- 保護既有單據不被改成低於已收金額
-- 已確認單據目前只開放改備註，但 patch-005 的 update_order_meta
-- 仍可能被擴充，這裡以 trigger 兜底。
-- ============================================
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
  -- view 讀到的仍是舊的 discount/tax，改小金額時會驗不出來。
  -- 必須直接用 NEW 的欄位重算。
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

drop trigger if exists orders_guard_allocations on orders;

create trigger orders_guard_allocations
before update on orders
for each row
execute function guard_order_total_against_allocations();

-- ============================================
-- RPC：原子儲存收款 + 逐單分配
-- 取代前端原本的三段式呼叫
-- （insert payments → delete payment_orders → insert payment_orders），
-- 該流程任一段失敗都會留下不一致資料。
-- 單號一律在 DB 端產生，避免前端併發產生重號。
-- ============================================
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
end;
$$;

-- ============================================
-- 停用手動修改付款狀態
-- payment_status 改由 order_payment_summary_view 推導，
-- 保留參數只為相容舊前端；傳值一律拒絕，避免靜默失敗讓人以為改成功了。
-- 欄位 orders.payment_status 暫時保留不刪，供 patch-010 的差異對照追溯，
-- 前端全部切換完畢後可另開 patch 移除。
-- ============================================
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
end;
$$;

-- ============================================
-- 索引
-- ============================================
create index if not exists idx_payment_orders_order_amount
  on payment_orders (order_id) include (amount);

create index if not exists idx_orders_sale_confirmed
  on orders (partner_id, order_date desc)
  where type = 'sale' and status = 'confirmed';
