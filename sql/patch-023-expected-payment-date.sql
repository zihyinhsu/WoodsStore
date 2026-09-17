-- patch-023-expected-payment-date
-- 預計收款日與追款清單
--
-- 背景：系統記得「誰欠多少」，但不記得「說好什麼時候付」。月結與票期的約定回款日
-- 只存在紙本或記憶裡，逾期不會有人發現。
--
-- 本 patch 在 orders 加上 expected_payment_date，並提供 receivable_followup_view
-- 供追款清單頁與每日提醒信共用（兩邊口徑必須一致，否則畫面與信件會對不起來）。
--
-- 提醒的對象是「還沒收到的錢」，所以日期掛在出貨單而非收款單：payments 有資料時
-- 錢已入帳，再提醒已無意義。實收日直接用 payments.payment_date，不另外開欄位。
--
-- schema.sql 已同步更新。既有正式庫套用本檔即可升級。

-- ------------------------------------------------------------------
-- 1. 欄位
-- ------------------------------------------------------------------
alter table orders add column if not exists expected_payment_date date;

comment on column orders.expected_payment_date is
  '預計收款日（月結／票期的約定回款日）。只對出貨單有意義；追款清單與每日提醒信以此排序與分類。';

-- 追款清單依預計收款日排序；只有已確認出貨單會談應收，其餘不進索引
create index if not exists idx_orders_expected_payment
  on orders (expected_payment_date)
  where type = 'sale' and status = 'confirmed';

-- ------------------------------------------------------------------
-- 2. 單據 RPC：三支都要能寫入預計收款日
--
--    必須先 drop 再 create：create or replace 遇到參數列表改變會建立「多載」而非取代，
--    PostgREST 以具名參數呼叫時會報 function is not unique（patch-021 對
--    dashboard_summary 也是同樣處理）。新參數一律加在最後並給預設值，
--    讓尚未更新的呼叫端維持可用。
-- ------------------------------------------------------------------
drop function if exists create_order(text, uuid, text, jsonb, date, numeric, numeric, text);

create function create_order(
  p_type text,
  p_partner uuid,
  p_note text,
  p_items jsonb,
  p_order_date date default current_date,
  p_discount numeric default 0,
  p_tax numeric default 0,
  p_status text default 'confirmed',
  p_expected_payment_date date default null
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

  insert into orders (order_no, type, status, partner_id, order_date, discount, tax, note,
                      expected_payment_date)
  values (
    'ORD-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || substr(md5(random()::text), 1, 4),
    p_type, p_status, p_partner, p_order_date, p_discount, p_tax, p_note,
    p_expected_payment_date
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

-- 編輯草稿單（整張替換 header + 明細）
-- 已確認/作廢不可經此修改；type 一律鎖定，改型別應作廢重開。
-- 預計收款日隨表頭整張替換：傳 null 即為清空，與 partner/note 的語意一致。
drop function if exists update_draft_order(uuid, uuid, text, jsonb, date, numeric, numeric);

create function update_draft_order(
  p_order_id uuid,
  p_partner uuid,
  p_note text,
  p_items jsonb,
  p_order_date date,
  p_discount numeric default 0,
  p_tax numeric default 0,
  p_expected_payment_date date default null
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
  set partner_id            = p_partner,
      note                  = p_note,
      order_date            = coalesce(p_order_date, order_date),
      discount              = coalesce(p_discount, 0),
      tax                   = coalesce(p_tax, 0),
      expected_payment_date = p_expected_payment_date
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

-- 編輯單據備註與預計收款日（已確認/草稿皆可，作廢不可）
-- payment_status 由收款紀錄推導，一律拒絕寫入；保留參數只為相容舊前端。
--
-- 預計收款日用 p_update_expected 旗標控制是否覆寫，不能沿用 note 的 coalesce 寫法：
-- coalesce 無法表達「清空」，傳 null 會被當成「不要動」，使用者就永遠刪不掉已填的日期。
drop function if exists update_order_meta(uuid, text, text);

create function update_order_meta(
  p_order_id             uuid,
  p_note                 text default null,
  p_payment_status       text default null,
  p_expected_payment_date date default null,
  p_update_expected      boolean default false
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
  set note = coalesce(p_note, note),
      expected_payment_date = case
        when p_update_expected then p_expected_payment_date
        else expected_payment_date
      end
  where id = p_order_id;
end $$;

-- ------------------------------------------------------------------
-- 3. 單據搜尋 view：追加輸出預計收款日
--    新欄位必須放在 select 尾端：create or replace view 只能在尾端追加欄位，
--    插在既有欄位之間會報 42P16 cannot change name of view column。
--    不必加進 group by：o.id 是主鍵，同表其餘欄位為函數相依，Postgres 允許直接引用。
-- ------------------------------------------------------------------
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
  o.expected_payment_date
from orders o
left join partners p     on p.id = o.partner_id
left join order_items oi on oi.order_id = o.id
left join products pr    on pr.id = oi.product_id
left join order_payment_summary_view ops on ops.order_id = o.id
group by o.id, p.name, p.tax_id,
         ops.payment_status, ops.paid_amount, ops.outstanding_amount;

-- ------------------------------------------------------------------
-- 4. 追款清單：未收清的出貨單 + 預計收款日分類
--    建在既有 outstanding_order_view 之上（它已是「outstanding_amount > 0」的定義來源），
--    不另寫一份未收判定，否則清單與單據頁的未結清條件可能漂移。
--
--    「今天」一律用台北時區，不可用 current_date：Supabase 的 session 時區是 UTC，
--    台北時間當天 08:00 前 current_date 會算成前一天，早上開頁面會看到昨天的分類
--    （與前端禁用 toISOString() 是同一個坑）。每日提醒信在早上寄出，正好落在這個區間內。
-- ------------------------------------------------------------------
create or replace view receivable_followup_view as
select
  ov.id as order_id,
  ov.order_no,
  ov.order_date,
  ov.partner_id,
  p.name       as partner_name,
  p.partner_no,
  p.phone      as partner_phone,
  o.expected_payment_date,
  ov.order_total,
  ov.paid_amount,
  ov.outstanding_amount,
  ov.payment_status,
  case
    when o.expected_payment_date is null then 'unscheduled'
    when o.expected_payment_date <  (now() at time zone 'Asia/Taipei')::date then 'overdue'
    when o.expected_payment_date =  (now() at time zone 'Asia/Taipei')::date then 'today'
    else 'upcoming'
  end as due_bucket,
  -- 正數為已逾期天數，負數為距到期還有幾天；未設定日期則為 null。
  ((now() at time zone 'Asia/Taipei')::date - o.expected_payment_date) as days_past_due
from outstanding_order_view ov
join orders o        on o.id = ov.id
left join partners p on p.id = ov.partner_id;

-- ------------------------------------------------------------------
-- 5. 權限：比照 schema.sql 第 7 節，全站需登入，anon 不得存取
--
--    函式經 drop/create 後權限會回到 Postgres 預設（PUBLIC 可執行），
--    原本撤掉 anon 的設定不會自動沿用，必須重新套用一次。
-- ------------------------------------------------------------------
revoke all on receivable_followup_view from anon;
grant select on receivable_followup_view to authenticated;

revoke all on function
  create_order(text, uuid, text, jsonb, date, numeric, numeric, text, date),
  update_draft_order(uuid, uuid, text, jsonb, date, numeric, numeric, date),
  update_order_meta(uuid, text, text, date, boolean)
  from public, anon;

grant execute on function
  create_order(text, uuid, text, jsonb, date, numeric, numeric, text, date),
  update_draft_order(uuid, uuid, text, jsonb, date, numeric, numeric, date),
  update_order_meta(uuid, text, text, date, boolean)
  to authenticated;
