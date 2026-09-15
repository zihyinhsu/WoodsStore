-- ============================================================
-- Patch 017：加上身分驗證 — 關閉 anon 存取，只允許登入者（authenticated）
-- 適用：已執行過 migration.sql + patch-001~016 的資料庫
-- 使用方式：整份貼到 Supabase SQL Editor → Run
--
-- ⚠️ 破壞性變更：套用後未登入（anon）將完全無法讀寫，連自己都會被鎖在外面。
--    套用前務必先完成：
--      1. Supabase → Authentication 建立好員工帳號
--      2. Authentication → Providers → Email 關閉「Allow new users to sign up」
--         （否則任何人自行註冊就取得 authenticated 身分，等於沒關門）
--      3. 前端 login 頁 + guard 已部署、測試已帶登入（tests/helpers.js）
-- ============================================================
-- 背景：
--   原本六張表 + audit 表的 RLS policy 都是 for all to anon（無登入版），
--   任何持有 anon key 的人可繞過前端、直接打 REST API 讀寫整個資料庫。
--   更隱蔽的是：多個 view（stock_view、partner_balance_view、order_search_view…）
--   未加 security_invoker，預設以 owner 權限執行、會「繞過」table 的 RLS，
--   因此只把 policy 改成 authenticated 仍會讓 anon 從 view 讀到全部資料。
--
--   所以改採「schema 層撤掉 anon 全部權限」+「policy 對象改 authenticated」雙管齊下，
--   一次涵蓋 table / view / function，避免逐一列舉 view 而漏掉。
--   本系統全站需登入、全員同權，anon 不需任何存取，全撤最安全也最不易漏。
-- ============================================================

-- ============================================
-- 1. Table policy：anon → authenticated
--    RLS 啟用下，authenticated 需有適用 policy 才能存取；
--    沿用原本的全開條件（全員同權），只是把對象從 anon 換成登入者。
-- ============================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'products', 'partners', 'orders', 'order_items',
    'payments', 'payment_orders', 'payment_allocation_migration_audit'
  ]
  loop
    execute format('drop policy if exists "anon full access" on %I', t);
    execute format(
      'create policy "authenticated full access" on %I for all to authenticated using (true) with check (true)',
      t
    );
  end loop;
end $$;

-- ============================================
-- 2. 撤掉 anon 對 public schema 的所有存取
--    這一步才是真正把 view / function 一起關上的關鍵：
--    view 多為 definer 語意、會繞過 table RLS，靠撤掉 anon 的 SELECT grant 擋住；
--    RPC 皆 security invoker，撤掉 EXECUTE 讓匿名呼叫直接失敗（而非回空集合）。
-- ============================================
revoke all on all tables    in schema public from anon;
revoke all on all routines  in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 未來新建的 table / view / function 也預設不開放 anon，避免日後加表又漏開門
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on routines  from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- ============================================
-- 3. 確保 authenticated 有必要權限
--    Supabase 專案預設已 grant，這裡明示以防環境差異；語句可重複執行。
-- ============================================
grant usage on schema public to authenticated;
grant all on all tables    in schema public to authenticated;
grant all on all routines  in schema public to authenticated;
grant all on all sequences in schema public to authenticated;

alter default privileges in schema public grant all on tables    to authenticated;
alter default privileges in schema public grant all on routines  to authenticated;
alter default privileges in schema public grant all on sequences to authenticated;

-- ============================================
-- 套用後自我驗證（擇一）：
--   1. 用 anon key 打 REST：
--      curl "$SUPABASE_URL/rest/v1/products?select=id" -H "apikey: <anon>"
--      應回 401 或空集合，而非商品清單。
--   2. 前端未登入開任一頁 → 應被導向 login.html。
--   3. 登入後六個頁面資料正常、可建單/收款。
-- ============================================
