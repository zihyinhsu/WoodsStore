-- ============================================================
-- Patch 007：商品編號自動產生
-- 適用：已執行過 migration.sql + patch-001~006 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 編號規則：P0001 起遞增，格式比照往來對象（C/S + 四位數）。
-- 使用 sequence 而非 max()+1，避免兩人同時新增時取到同一個號碼。
--
-- 既有商品不改號：舊編號可能已印在既有單據上，改號會失去對應。
-- 因此本 patch 只讓新商品自動取號，不回填。

create sequence if not exists product_sku_seq start with 1;

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
  -- 空字串也視為未填，否則會寫入空值並佔用唯一鍵
  if new.sku is null or btrim(new.sku) = '' then
    new.sku := next_product_sku();
  end if;
  return new;
end $$;

drop trigger if exists trg_set_product_sku on products;
create trigger trg_set_product_sku
  before insert on products
  for each row
  execute function set_product_sku();

-- ============================================
-- 讓 sequence 跳過已被占用的號碼
-- ============================================
select setval('product_sku_seq',
  greatest(
    (select coalesce(max(substring(sku from 2)::int), 0)
     from products
     where sku ~ '^P[0-9]+$'),
    1));

-- ============================================
-- sku 原為 not null，改為可空以便交由 trigger 產生
-- ============================================
alter table products alter column sku drop not null;
