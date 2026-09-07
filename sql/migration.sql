-- ============================================================
-- 簡易進銷存系統 migration（無登入版）
-- 使用方式：整份貼到 Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ============================================
-- 商品
-- ============================================
create table products (
  id            uuid primary key default gen_random_uuid(),
  sku           text unique not null,              -- 商品編號
  barcode       text unique,                       -- 條碼（掃描槍用）
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

-- ============================================
-- 往來對象（供應商 / 客戶）
-- ============================================
create table partners (
  id             uuid primary key default gen_random_uuid(),
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

-- ============================================
-- 單據主檔（進貨 / 銷貨 / 調整）
-- ============================================
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

-- ============================================
-- 單據明細（＝庫存異動流水帳）
-- ============================================
create table order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid not null references products(id),
  qty         int not null,                        -- 進貨為正、銷貨為負（由 RPC 控制）
  unit_price  numeric(12,2) not null default 0,
  discount    numeric(5,2) default 0,              -- 明細折扣（%）
  subtotal    numeric(12,2)
              generated always as (abs(qty) * unit_price * (1 - discount/100)) stored
);

-- ============================================
-- 索引
-- ============================================
create index idx_orders_order_date   on orders (order_date desc);
create index idx_orders_type_date    on orders (type, order_date desc);
create index idx_order_items_product on order_items (product_id);
create index idx_order_items_order   on order_items (order_id);

-- ============================================
-- 即時庫存 View（只計已確認單據）
-- ============================================
create view stock_view as
select p.id, p.sku, p.barcode, p.name, p.spec, p.category, p.unit,
       p.cost, p.price, p.tax_type, p.safety_stock, p.location,
       p.image_url, p.is_active, p.created_at,
       coalesce(sum(oi.qty) filter (where o.status = 'confirmed'), 0) as stock_qty
from products p
left join order_items oi on oi.product_id = p.id
left join orders o       on o.id = oi.order_id
group by p.id;

-- ============================================
-- 單據搜尋 View（時間區間 + 關鍵字）
-- ============================================
create view order_search_view as
select
  o.id, o.order_no, o.type, o.status, o.order_date,
  o.discount, o.tax, o.payment_status, o.note, o.created_at,
  o.partner_id,
  p.name as partner_name,
  count(oi.id)     as item_count,
  coalesce(sum(oi.subtotal), 0) as total_amount,
  o.order_no || ' ' || coalesce(o.note,'')
    || ' ' || coalesce(p.name,'') || ' ' || coalesce(p.tax_id,'')
    || ' ' || coalesce(string_agg(
         pr.name || ' ' || pr.sku || ' ' || coalesce(pr.barcode,''), ' '), '')
    as search_text
from orders o
left join partners p     on p.id = o.partner_id
left join order_items oi on oi.order_id = o.id
left join products pr    on pr.id = oi.product_id
group by o.id, p.name, p.tax_id;

-- ============================================
-- RPC：建單（原子性 + 防超賣）
-- p_items 範例：
--   [{"product_id":"uuid","qty":3,"unit_price":100,"discount":0}]
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

  return v_order_id;
end $$;

-- ============================================
-- RPC：確認草稿單（銷貨單此時才做防超賣檢查）
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

  update orders set status = 'confirmed' where id = p_order_id;
end $$;

-- ============================================
-- RPC：作廢單據（庫存自動回沖，因 stock_view 只計 confirmed）
-- ============================================
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

-- ============================================
-- RLS（無登入版：開放 anon 讀寫）
-- ⚠️ 任何持有 anon key 的人都可讀寫，僅適合內網/個人使用。
--    未來要加登入時，把 to anon 改為 to authenticated 即可。
-- ============================================
alter table products    enable row level security;
alter table partners    enable row level security;
alter table orders      enable row level security;
alter table order_items enable row level security;

create policy "anon full access" on products
  for all to anon using (true) with check (true);
create policy "anon full access" on partners
  for all to anon using (true) with check (true);
create policy "anon full access" on orders
  for all to anon using (true) with check (true);
create policy "anon full access" on order_items
  for all to anon using (true) with check (true);

-- ============================================
-- 範例資料（可選，不需要可刪除此區塊）
-- ============================================
insert into partners (name, type, tax_id, contact_name, phone) values
  ('大同五金行', 'supplier', '12345678', '陳老闆', '02-1234-5678'),
  ('王小明', 'customer', null, '王小明', '0912-345-678');

insert into products (sku, barcode, name, spec, category, unit, cost, price, safety_stock, location) values
  ('P001', '4710000000011', '不鏽鋼螺絲', 'M4x10mm', '五金', '包', 20, 35, 10, 'A1-01'),
  ('P002', '4710000000028', '電工膠帶', '黑色 18mm', '耗材', '捲', 8, 15, 20, 'A2-03'),
  ('P003', null, 'LED 燈泡', 'E27 10W 白光', '照明', '顆', 45, 79, 5, 'B1-02');
