-- patch-027-supplier-payments
-- 進貨單付款狀態：付款給供應商，沿用收款的同一套表與沖帳機制
--
-- 背景：付款狀態原本只追蹤出貨單（應收），進貨單在每一層都被排除——彙總 view 只算
-- sale、沖帳 trigger 拒絕非出貨單、收款 RPC 只收客戶——所以進貨單看不出付了沒有。
--
-- 設計：不新增資料表。payments / payment_orders 收付同表，方向由往來對象推導：
--   客戶   → 收款，只能沖已確認的出貨單（應收）
--   供應商 → 付款，只能沖已確認的進貨單（應付）
-- 付款狀態仍是推導值（payment_orders.amount 為單一事實來源），不開放手動切換。
-- 另開一組 supplier_payments 表會讓收付款兩套幾乎相同的程式碼並存，改一邊漏另一邊。
--
-- 歷史進貨單套用後一律顯示「未付款」：刻意不回填付款紀錄，由使用者自行補登。
--
-- 必須一併處理的連帶影響（payments 不再只有客戶）：
--   - outstanding_order_view 限定 sale：它是「應收」的定義來源，unpaid_order_view 與
--     追款清單（feat/expected-payment-reminder）都建在它上面。
--   - statement_summary 限定客戶：cur_paid 直接讀 payments，否則付過款的供應商會出現在對帳單。
--   - partner_balance_view 本來就 where p.type = 'customer'，不必改。
--
-- 整份可重複執行：view 一律 create or replace（新欄只追加在尾端），
-- get_partner_balances 加參數故先 drop 舊簽名，避免留下 ambiguous 的重載。

-- ----------------------------------------
-- 單據收付款彙總（付款狀態的唯一推導來源）
-- 涵蓋已確認的出貨單（應收）與進貨單（應付），以 type 區分；調整/草稿/作廢單不談收付。
-- type 放在最後一欄：create or replace view 只能在尾端追加欄位（patch-027）。
-- ----------------------------------------
create or replace view order_payment_summary_view as
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
  end as payment_status,
  ot.type
from order_total_view ot
left join payment_orders po on po.order_id = ot.order_id
where ot.type in ('sale', 'purchase')
  and ot.status = 'confirmed'
group by
  ot.order_id, ot.partner_id, ot.order_no, ot.order_date, ot.order_total, ot.type;

-- 未收清單：用 outstanding_amount > 0 判定，部分收款的單仍留在清單。
-- 只留出貨單：這支是「應收」的定義來源（unpaid_order_view、追款清單都建在它上面），
-- 應付混進來會讓供應商被當成要追款的對象。未付進貨單直接查 order_payment_summary_view。
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
where s.type = 'sale'
  and s.outstanding_amount > 0;

-- ----------------------------------------
-- 單據搜尋（時間區間 + 關鍵字）
-- payment_status 讀推導值；total_amount 為淨額（小計 − 折讓 + 稅），
-- 與付款狀態、partner_balance_view、dashboard_summary 同口徑。
-- item_count 仍在這裡自己 count：這裡是 left join orders，沒有明細的單要算 0，
-- 而 order_top_item_view 根本不會有那一列。
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
-- 收款搜尋
-- order_ids 供「從單據跳來」時 contains 過濾；order_nos 併進 search_text。
-- ----------------------------------------
create or replace view payment_search_view as
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
  coalesce(alloc.top_item_count, 0) as top_item_count,
  -- patch-027 追加：收付款同表，前端依此分「收款（customer）／付款（supplier）」兩個分頁。
  pt.type as partner_type
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


-- 編輯單據備註（已確認/草稿皆可，作廢不可）
-- payment_status 由收付款紀錄推導，一律拒絕寫入；保留參數只為相容舊前端。
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
    raise exception 'PAYMENT_STATUS_READONLY: 付款狀態由收付款紀錄推導，請至收付款管理新增或修改';
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


-- 原子儲存收付款 + 逐單分配（取代前端三段式呼叫，任一段失敗都會留下不一致資料）。
-- 單號一律在 DB 端產生，避免前端併發產生重號。
-- 對象為客戶即收款、為供應商即付款（patch-027），方向不另傳參數，由對象類型決定。
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

    if v_alloc.amount is null or v_alloc.amount <= 0 then
      raise exception 'ALLOCATION_AMOUNT_INVALID';
    end if;

    insert into payment_orders (payment_id, order_id, amount)
    values (v_payment_id, v_alloc.order_id, v_alloc.amount);
  end loop;

  -- 交易 commit 時，constraint trigger 會驗證：
  --   1. 分配總額 <= 收款金額
  --   2. 每張單分配總額 <= 單據金額
  --   3. 收付款對象 = 單據對象
  --   4. 只能沖已確認的出貨單／進貨單，且方向相符（客戶沖出貨、供應商沖進貨）
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
  v_partner_type      text;
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
  select pay.amount, pay.partner_id, pt.type
    into v_payment_amount, v_payment_partner, v_partner_type
  from payments pay
  left join partners pt on pt.id = pay.partner_id
  where pay.id = v_payment_id;

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
    if v_order_type not in ('sale', 'purchase') or v_order_status <> 'confirmed' then
      raise exception 'ALLOCATION_TARGET_INVALID: 只能沖帳已確認的出貨單或進貨單';
    end if;

    -- 對象一致性只擋得住「單據 partner_id 不同」；單據沒掛對象（partner_id 為 null）時
    -- 會放行，因此方向要另外驗：客戶的收款沖進貨單會讓應付憑空被「收」掉。
    if v_partner_type is not null
       and (v_partner_type = 'customer') <> (v_order_type = 'sale') then
      raise exception 'ALLOCATION_DIRECTION_MISMATCH: 客戶只能沖出貨單、供應商只能沖進貨單';
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
      raise exception 'ALLOCATION_PARTNER_MISMATCH: 收付款對象與單據對象不一致';
    end if;
  end if;

  return null;
end;
$$;

-- 客戶應收／供應商應付餘額（截至指定日期、可依對象或關鍵字篩選、由前端分頁）
-- 口徑選「期末快照」而非「期間發生額」：積欠但近期沒下單的客戶餘額才不會顯示 0。
-- 三個 CTE 的截止日必須一致，只截其中一側會讓 unallocated_credit 變負數。
-- p_partner_id / p_keyword 凌駕 p_include_settled：明確指定就必須看得到，即使已結清。
-- p_partner_type（patch-027）：'supplier' 時改算進貨單與付款＝應付。回傳欄位名稱沿用
-- total_sales（此時代表進貨總額）、total_paid（已付）不改名，既有呼叫端才不必跟著改。
-- 加參數必須先 drop：create or replace 會留下舊的 4 參數版成為重載，具名呼叫時 ambiguous。
drop function if exists get_partner_balances(date, uuid, boolean, text);
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
    where ot.type = case when p_partner_type = 'supplier' then 'purchase' else 'sale' end
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
  left join prev_paid  pp on pp.partner_id = p.id
  -- payments 收付款同表（patch-027），cur_paid 會帶進付過款的供應商，必須只留客戶。
  where p.type = 'customer';
$$;
