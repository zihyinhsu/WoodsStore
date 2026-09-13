-- ============================================================
-- Patch 006：往來對象編號自動產生
-- 適用：已執行過 migration.sql + patch-001~005 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
-- ============================================================
-- 編號規則：客戶 C0001 起、供應商 S0001 起，各自獨立遞增。
-- 使用 sequence 而非 max()+1，避免兩人同時新增時取到同一個號碼。

create sequence if not exists partner_no_customer_seq start with 1;
create sequence if not exists partner_no_supplier_seq start with 1;

-- ============================================
-- 依類型取號；未填編號時由 trigger 自動補上
-- ============================================
create or replace function next_partner_no(p_type text)
returns text
language plpgsql
as $$
begin
  if p_type = 'supplier' then
    return 'S' || lpad(nextval('partner_no_supplier_seq')::text, 4, '0');
  end if;
  return 'C' || lpad(nextval('partner_no_customer_seq')::text, 4, '0');
end $$;

create or replace function set_partner_no()
returns trigger
language plpgsql
as $$
begin
  -- 空字串也視為未填，否則會寫入空值並佔用唯一鍵
  if new.partner_no is null or btrim(new.partner_no) = '' then
    new.partner_no := next_partner_no(new.type);
  end if;
  return new;
end $$;

drop trigger if exists trg_set_partner_no on partners;
create trigger trg_set_partner_no
  before insert on partners
  for each row
  execute function set_partner_no();

-- ============================================
-- 回填既有資料：依建立時間依序給號
-- ============================================
do $$
declare
  r record;
begin
  for r in
    select id, type from partners
    where partner_no is null or btrim(partner_no) = ''
    order by created_at
  loop
    update partners set partner_no = next_partner_no(r.type) where id = r.id;
  end loop;
end $$;

-- ============================================
-- 讓 sequence 跳過已被占用的號碼
-- 若原本已存在手動輸入的 C/S 編號，避免之後取號撞號
-- ============================================
select setval('partner_no_customer_seq',
  greatest(
    (select coalesce(max(substring(partner_no from 2)::int), 0)
     from partners
     where partner_no ~ '^C[0-9]+$'),
    1));

select setval('partner_no_supplier_seq',
  greatest(
    (select coalesce(max(substring(partner_no from 2)::int), 0)
     from partners
     where partner_no ~ '^S[0-9]+$'),
    1));
