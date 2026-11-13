-- verify-030-returns
-- 驗證 patch-030（銷貨退回／進貨退出）。整份包在 begin ... rollback，不留任何資料。
--
-- 用法：先執行 patch-030，再整份貼進 SQL Editor（或 psql -v ON_ERROR_STOP=1 -f）。
-- 結果：最後一個 select 列出每個案例的 PASS/FAIL；任何一個 FAIL 會讓最後的 DO 區塊報錯。
--
-- 注意事項（為什麼這樣寫）：
--   - 測試資料一律指定 sku、partner_no：rollback 不會歸還 sequence 已取的號碼，
--     不指定會讓正式環境的編號跳號。單號由 RPC 用隨機碼產生，不吃 sequence。
--   - 日期全用 2099 年：報表區間只會撈到這裡建的資料，不受實際資料影響。
--   - constraint trigger 是 deferrable initially deferred，而這份腳本永遠不 commit，
--     所以必須用 set constraints all immediate 手動「沖刷」，否則收付款驗證完全不會觸發。
--   - 預期失敗的案例包在子交易（exception block）裡，失敗時該段寫入自動回滾。
--   - 不要傳 allowWrites 之類的繞法：這份腳本只該在 DEV 或明確同意的環境跑。

begin;

create temp table vt  (k text primary key, id uuid) on commit drop;
create temp table vlog (n serial primary key, name text not null, ok boolean not null, detail text) on commit drop;

-- ----------------------------------------
-- 測試輔助函式（pg_temp：只活在這個 session，不污染 schema）
-- ----------------------------------------
create function pg_temp.vid(p_k text) returns uuid language sql as $$
  select id from vt where k = p_k;
$$;

create function pg_temp.reg(p_k text, p_id uuid) returns uuid language sql as $$
  insert into vt values (p_k, p_id) returning id;
$$;

create function pg_temp.t_ok(p_name text, p_cond boolean, p_detail text default null)
returns void language sql as $$
  insert into vlog (name, ok, detail) values (p_name, coalesce(p_cond, false), p_detail);
$$;

create function pg_temp.t_num(p_name text, p_actual numeric, p_expected numeric)
returns void language sql as $$
  insert into vlog (name, ok, detail)
  values (p_name, p_actual is not distinct from p_expected,
          'actual=' || coalesce(p_actual::text, 'null') || ', expected=' || coalesce(p_expected::text, 'null'));
$$;

create function pg_temp.t_txt(p_name text, p_actual text, p_expected text)
returns void language sql as $$
  insert into vlog (name, ok, detail)
  values (p_name, p_actual is not distinct from p_expected,
          'actual=' || coalesce(p_actual, 'null') || ', expected=' || coalesce(p_expected, 'null'));
$$;

-- 沖刷 deferred constraint trigger（見檔頭說明）。
create function pg_temp.flush() returns void language plpgsql as $$
begin
  set constraints all immediate;
  set constraints all deferred;
end $$;

-- 預期 p_sql 失敗且錯誤訊息含 p_code。意外成功時用特殊例外把寫入回滾掉，避免污染後續案例。
create function pg_temp.t_raises(p_name text, p_sql text, p_code text)
returns void language plpgsql as $$
declare
  v_msg text;
begin
  begin
    execute p_sql;
    perform pg_temp.flush();
    raise exception 'VT_NO_ERROR';
  exception when others then
    v_msg := sqlerrm;
  end;

  if v_msg = 'VT_NO_ERROR' then
    insert into vlog (name, ok, detail) values (p_name, false, '預期失敗（' || p_code || '）但執行成功');
  else
    insert into vlog (name, ok, detail)
    values (p_name, position(p_code in v_msg) > 0, 'expected=' || p_code || ', message=' || v_msg);
  end if;
end $$;

-- 預期 p_sql 成功（含沖刷 deferred trigger）；失敗時記錄 FAIL 與錯誤訊息，腳本繼續跑。
create function pg_temp.t_runs(p_name text, p_sql text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.flush();
  exception when others then
    insert into vlog (name, ok, detail) values (p_name, false, 'unexpected error: ' || sqlerrm);
    return;
  end;
  insert into vlog (name, ok, detail) values (p_name, true, null);
end $$;

-- 一列明細（原單用）／一列退貨明細：原單明細以「單據 key + 商品 key」定位。
create function pg_temp.li(p_prod text, p_qty int, p_price numeric)
returns jsonb language sql as $$
  select jsonb_build_object('product_id', pg_temp.vid(p_prod), 'qty', p_qty, 'unit_price', p_price);
$$;

create function pg_temp.ri(p_order text, p_prod text, p_qty int, p_price numeric)
returns jsonb language sql as $$
  select jsonb_build_object(
    'item_id', (select oi.id from order_items oi
                where oi.order_id = pg_temp.vid(p_order) and oi.product_id = pg_temp.vid(p_prod)
                order by oi.id limit 1),
    'qty', p_qty, 'unit_price', p_price);
$$;

-- 建原單（沿用 create_order，成本快照走正式路徑）。
create function pg_temp.mk(p_k text, p_type text, p_partner text, p_date date, p_items jsonb,
                           p_discount numeric default 0, p_tax numeric default 0)
returns uuid language sql as $$
  select pg_temp.reg(p_k, create_order(p_type, pg_temp.vid(p_partner), 'VT030', p_items, p_date, p_discount, p_tax));
$$;

-- 建退貨單。
create function pg_temp.mkret(p_k text, p_orig text, p_items jsonb, p_date date,
                              p_discount numeric default 0, p_tax numeric default 0)
returns uuid language sql as $$
  select pg_temp.reg(p_k, create_return_order(pg_temp.vid(p_orig), p_items, p_date, p_discount, p_tax, 'VT030'));
$$;

create function pg_temp.stock(p_prod text) returns numeric language sql as $$
  select coalesce(sum(oi.qty), 0) from order_items oi join orders o on o.id = oi.order_id
  where oi.product_id = pg_temp.vid(p_prod) and o.status = 'confirmed';
$$;

create function pg_temp.otot(p_order text) returns numeric language sql as $$
  select order_total from order_total_view where order_id = pg_temp.vid(p_order);
$$;

-- 建收付款：p_allocs 例 '[["rd", -200], ["sald", 500]]'（單據 key, 金額）。
create function pg_temp.allocs(p_pairs jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('order_id', pg_temp.vid(x->>0), 'amount', (x->>1)::numeric)), '[]'::jsonb)
  from jsonb_array_elements(p_pairs) x;
$$;

-- ----------------------------------------
-- 0. 基礎資料（明確指定 sku／partner_no，不吃 sequence）
-- ----------------------------------------
create function pg_temp.mkpartner(p_k text, p_no text, p_name text, p_type text)
returns uuid language sql as $$
  with ins as (insert into partners (partner_no, name, type) values (p_no, p_name, p_type) returning id)
  select pg_temp.reg(p_k, id) from ins;
$$;

create function pg_temp.mkproduct(p_k text, p_sku text, p_name text)
returns uuid language sql as $$
  with ins as (insert into products (sku, name, cost) values (p_sku, p_name, 0) returning id)
  select pg_temp.reg(p_k, id) from ins;
$$;

select pg_temp.mkpartner('c1', 'VT030-C1', 'VT030 客戶1', 'customer');
select pg_temp.mkpartner('c2', 'VT030-C2', 'VT030 客戶2', 'customer');
select pg_temp.mkpartner('c3', 'VT030-C3', 'VT030 客戶3', 'customer');
select pg_temp.mkpartner('c4', 'VT030-C4', 'VT030 客戶4', 'customer');
select pg_temp.mkpartner('s1', 'VT030-S1', 'VT030 供應商1', 'supplier');
select pg_temp.mkpartner('s2', 'VT030-S2', 'VT030 供應商2', 'supplier');
select pg_temp.mkproduct('p1', 'VT030-P1', 'VT030 商品1');
select pg_temp.mkproduct('p2', 'VT030-P2', 'VT030 商品2');
select pg_temp.mkproduct('p3', 'VT030-P3', 'VT030 商品3');
select pg_temp.mkproduct('p4', 'VT030-P4', 'VT030 商品4');

-- 進貨：P1 100 @ 20（供 SAL1 等銷貨，均價 20）
select pg_temp.mk('pur1', 'purchase', 's1', date '2099-03-01', jsonb_build_array(pg_temp.li('p1', 100, 20)));

-- 原單 SAL1：P1 10 @ 100，整單折讓 100、稅額 50 → 總額 950，成本快照 20
select pg_temp.mk('sal1', 'sale', 'c1', date '2099-04-10', jsonb_build_array(pg_temp.li('p1', 10, 100)), 100, 50);

select pg_temp.t_num('0.1 SAL1 總額 950', pg_temp.otot('sal1'), 950);
select pg_temp.t_num('0.2 SAL1 成本快照 20',
  (select unit_cost from order_items where order_id = pg_temp.vid('sal1')), 20);
select pg_temp.t_num('0.3 order_amount_sign：sale=1／sale_return=-1／purchase_return=-1',
  order_amount_sign('sale') * 100 + order_amount_sign('sale_return') * 10 + order_amount_sign('purchase_return'),
  100 - 10 - 1);

-- ============================================================
-- A. 銷貨退回：限額與錯誤碼
-- ============================================================
select pg_temp.t_raises('A1 超退數量（11 > 10）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',11,100)), date '2099-04-15') $q$,
  'RETURN_QTY_EXCEEDS');
select pg_temp.t_raises('A2 超價（101 > 100）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',1,101)), date '2099-04-15') $q$,
  'RETURN_PRICE_EXCEEDS');
select pg_temp.t_raises('A3 退貨日早於原單',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',1,100)), date '2099-04-09') $q$,
  'RETURN_DATE_INVALID');
select pg_temp.t_raises('A4 單次折讓超過原單（101 > 100）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',10,100)), date '2099-04-15', 101, 0) $q$,
  'RETURN_AMOUNT_EXCEEDS');
select pg_temp.t_raises('A5 單次稅額超過原單（51 > 50）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',1,100)), date '2099-04-15', 0, 51) $q$,
  'RETURN_AMOUNT_EXCEEDS');
select pg_temp.t_raises('A6 明細不屬於此原單（拿進貨單的明細來退）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('pur1','p1',1,10)), date '2099-04-15') $q$,
  '退貨明細不屬於此原單');
select pg_temp.t_raises('A7 數量 0',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',0,100)), date '2099-04-15') $q$,
  '退貨數量必須大於 0');
select pg_temp.t_raises('A8 明細為空',
  $q$ select pg_temp.mkret('x', 'sal1', '[]'::jsonb, date '2099-04-15') $q$,
  '退貨明細不可為空');
select pg_temp.t_raises('A9 折讓為負',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',1,100)), date '2099-04-15', -1, 0) $q$,
  '不可為負數');
select pg_temp.t_raises('A10 折讓大於明細合計（淨額為負）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',1,100)), date '2099-04-15', 101, 0) $q$,
  '退貨單淨額不可為負數');

select pg_temp.reg('draft1', create_order('sale', pg_temp.vid('c1'), 'VT030',
  jsonb_build_array(pg_temp.li('p1', 1, 100)), date '2099-04-10', 0, 0, 'draft'));
select pg_temp.t_raises('A11 草稿單不可退貨',
  $q$ select pg_temp.mkret('x', 'draft1', jsonb_build_array(pg_temp.ri('draft1','p1',1,100)), date '2099-04-15') $q$,
  '只能對已確認');

select pg_temp.t_num('A12 失敗的嘗試都回滾，SAL1 沒有任何退貨單',
  (select count(*) from orders where return_of_order_id = pg_temp.vid('sal1')), 0);

-- 第一次退貨 R1：4 @ 100，折讓 40、稅 20 → -(400 - 40 + 20) = -380
select pg_temp.mkret('r1', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',4,100)), date '2099-04-15', 40, 20);

select pg_temp.t_txt('A13 R1 類型', (select type from orders where id = pg_temp.vid('r1')), 'sale_return');
select pg_temp.t_txt('A14 R1 狀態（建立即生效）', (select status from orders where id = pg_temp.vid('r1')), 'confirmed');
select pg_temp.t_ok('A15 R1 單號前綴 RTN-', (select order_no like 'RTN-%' from orders where id = pg_temp.vid('r1')));
select pg_temp.t_ok('A16 R1 連回原單與原明細',
  (select o.return_of_order_id = pg_temp.vid('sal1')
      and oi.return_of_item_id = (select id from order_items where order_id = pg_temp.vid('sal1'))
   from orders o join order_items oi on oi.order_id = o.id where o.id = pg_temp.vid('r1')));
select pg_temp.t_num('A17 R1 明細 qty 為正（銷貨退回回庫）',
  (select qty from order_items where order_id = pg_temp.vid('r1')), 4);
select pg_temp.t_num('A18 R1 沿用原單成本快照 20',
  (select unit_cost from order_items where order_id = pg_temp.vid('r1')), 20);
select pg_temp.t_num('A19 R1 order_total 為負（-380）', pg_temp.otot('r1'), -380);
select pg_temp.t_num('A20 庫存：100 - 10 + 4', pg_temp.stock('p1'), 94);
select pg_temp.t_num('A21 stock_view 與流水帳一致',
  (select stock_qty from stock_view where id = pg_temp.vid('p1')), 94);

select pg_temp.t_raises('A22 退貨單不可再被退',
  $q$ select pg_temp.mkret('x', 'r1', jsonb_build_array(pg_temp.ri('r1','p1',1,100)), date '2099-04-16') $q$,
  '只能對已確認');
select pg_temp.t_raises('A23 累計超退（已退 4，再退 7 > 6）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',7,100)), date '2099-04-16') $q$,
  'RETURN_QTY_EXCEEDS');
select pg_temp.t_raises('A24 多次退貨折讓累計超過原單（40 + 70 > 100）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',3,100)), date '2099-04-16', 70, 0) $q$,
  'RETURN_AMOUNT_EXCEEDS');
select pg_temp.t_raises('A25 多次退貨稅額累計超過原單（20 + 40 > 50）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',3,100)), date '2099-04-16', 0, 40) $q$,
  'RETURN_AMOUNT_EXCEEDS');

-- 第二次退貨 R2：3 @ 100，折讓 30、稅 10 → -(300 - 30 + 10) = -280（累計折讓 70 ≤ 100、稅 30 ≤ 50）
select pg_temp.mkret('r2', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',3,100)), date '2099-04-20', 30, 10);
select pg_temp.t_num('A26 R2 order_total（-280）', pg_temp.otot('r2'), -280);
select pg_temp.t_raises('A27 累計超退（已退 7，再退 4 > 3）',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',4,100)), date '2099-04-21') $q$,
  'RETURN_QTY_EXCEEDS');

-- 退貨單價可低於原價（議價退）：R3 用 1 @ 80 退出，之後立刻作廢，不影響後面的數字。
select pg_temp.t_runs('A28 退貨單價低於原價可接受（1 @ 80）',
  $q$ select pg_temp.mkret('r3', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',1,80)), date '2099-04-21') $q$);
select pg_temp.t_num('A29 R3 order_total（-80）', pg_temp.otot('r3'), -80);
select void_order(pg_temp.vid('r3'));

-- 在 order_search_view 看退貨單
select pg_temp.t_num('A30 search_view：R1 total_amount 為負',
  (select total_amount from order_search_view where id = pg_temp.vid('r1')), -380);
select pg_temp.t_txt('A31 search_view：R1 payment_status 有值（unpaid）',
  (select payment_status from order_search_view where id = pg_temp.vid('r1')), 'unpaid');
select pg_temp.t_txt('A32 search_view：R1 return_of_order_no = SAL1 單號',
  (select return_of_order_no from order_search_view where id = pg_temp.vid('r1')),
  (select order_no from orders where id = pg_temp.vid('sal1')));
select pg_temp.t_ok('A33 search_view：R1 return_of_order_id = SAL1',
  (select return_of_order_id = pg_temp.vid('sal1') from order_search_view where id = pg_temp.vid('r1')));
select pg_temp.t_num('A34 search_view：SAL1 return_count = 2（R3 已作廢不計）',
  (select return_count from order_search_view where id = pg_temp.vid('sal1')), 2);
select pg_temp.t_num('A35 search_view：SAL1 total_amount 仍為正 950',
  (select total_amount from order_search_view where id = pg_temp.vid('sal1')), 950);
select pg_temp.t_ok('A36 search_text 含原單單號（搜原單號撈得到退貨單）',
  (select search_text like '%' || (select order_no from orders where id = pg_temp.vid('sal1')) || '%'
   from order_search_view where id = pg_temp.vid('r1')));

-- 約束
select pg_temp.t_raises('A37 DB 約束：退貨類型必須有原單',
  $q$ insert into orders (order_no, type, status) values ('VT030-BAD1', 'sale_return', 'confirmed') $q$,
  'orders_return_link_check');
select pg_temp.t_raises('A38 DB 約束：一般單不可掛原單',
  $q$ insert into orders (order_no, type, status, return_of_order_id)
      values ('VT030-BAD2', 'sale', 'confirmed', pg_temp.vid('sal1')) $q$,
  'orders_return_link_check');
select pg_temp.t_raises('A39 DB 約束：未知單據類型',
  $q$ insert into orders (order_no, type, status) values ('VT030-BAD3', 'foo', 'confirmed') $q$,
  'orders_type_check');
select pg_temp.t_ok('A40 idx_orders_sale_confirmed 已涵蓋 sale_return',
  (select indexdef like '%sale_return%' from pg_indexes where indexname = 'idx_orders_sale_confirmed'));

-- ============================================================
-- B. 進貨退出：庫存、均價
-- ============================================================
select pg_temp.mk('pur2', 'purchase', 's1', date '2099-03-02', jsonb_build_array(pg_temp.li('p2', 10, 20)));
select pg_temp.mk('pur3', 'purchase', 's1', date '2099-03-05', jsonb_build_array(pg_temp.li('p2', 10, 21)));
select pg_temp.t_num('B1 退貨前累計進貨均價 (200+210)/20 = 20.5',
  purchase_avg_cost_asof(pg_temp.vid('p2'), date '2099-12-31'), 20.5);

-- 賣出 14，庫存剩 6（客戶 c4），成本快照取 20.5
select pg_temp.mk('salp2', 'sale', 'c4', date '2099-03-20', jsonb_build_array(pg_temp.li('p2', 14, 30)));
select pg_temp.t_num('B2 SALP2 成本快照 20.5',
  (select unit_cost from order_items where order_id = pg_temp.vid('salp2')), 20.5);

select pg_temp.t_raises('B3 進貨退出庫存不足（庫存 6，退 7）',
  $q$ select pg_temp.mkret('x', 'pur3', jsonb_build_array(pg_temp.ri('pur3','p2',7,21)), date '2099-03-25') $q$,
  'RETURN_STOCK_INSUFFICIENT');
select pg_temp.t_raises('B4 進貨退出超價（22 > 21）',
  $q$ select pg_temp.mkret('x', 'pur3', jsonb_build_array(pg_temp.ri('pur3','p2',1,22)), date '2099-03-25') $q$,
  'RETURN_PRICE_EXCEEDS');

-- 退 4 @ 20（低於原進價 21）
select pg_temp.mkret('pr1', 'pur3', jsonb_build_array(pg_temp.ri('pur3','p2',4,20)), date '2099-03-25');
select pg_temp.t_txt('B5 PR1 類型', (select type from orders where id = pg_temp.vid('pr1')), 'purchase_return');
select pg_temp.t_num('B6 PR1 明細 qty 為負（出庫）',
  (select qty from order_items where order_id = pg_temp.vid('pr1')), -4);
select pg_temp.t_num('B7 PR1 order_total（-80）', pg_temp.otot('pr1'), -80);
select pg_temp.t_num('B8 庫存：20 - 14 - 4', pg_temp.stock('p2'), 2);
select pg_temp.t_num('B9 退貨後均價 (200+210-80)/(20-4) = 20.625',
  purchase_avg_cost_asof(pg_temp.vid('p2'), date '2099-12-31'), 20.625);
select pg_temp.t_num('B10 退貨日之前的均價不受影響（截至 03-24 仍 20.5）',
  purchase_avg_cost_asof(pg_temp.vid('p2'), date '2099-03-24'), 20.5);

-- 全退光：分母為 0 回 null
select pg_temp.mk('pur4', 'purchase', 's1', date '2099-03-01', jsonb_build_array(pg_temp.li('p3', 5, 10)));
select pg_temp.mkret('pr3', 'pur4', jsonb_build_array(pg_temp.ri('pur4','p3',5,10)), date '2099-03-02');
select pg_temp.t_ok('B11 全部退光，均價為 null（不是除以 0 報錯）',
  purchase_avg_cost_asof(pg_temp.vid('p3'), date '2099-12-31') is null);
select pg_temp.t_num('B12 庫存歸零', pg_temp.stock('p3'), 0);

-- ============================================================
-- C. 報表、對帳單、餘額的數字（2099 年 4 月只有 SAL1／R1／R2）
-- SAL1 淨額 1000-100 = 900，R1 -(400-40) = -360，R2 -(300-30) = -270 → 淨 270、3 件、成本 60
-- ============================================================
select pg_temp.t_num('C1 product_movement：淨出貨件數 10-4-3 = 3',
  (select sale_qty from product_movement(date '2099-04-01', date '2099-04-30') where product_id = pg_temp.vid('p1')), 3);
select pg_temp.t_num('C2 product_movement：出貨淨額 900-360-270 = 270',
  (select sale_amount from product_movement(date '2099-04-01', date '2099-04-30') where product_id = pg_temp.vid('p1')), 270);
select pg_temp.t_num('C3 product_movement：成本 20×(10-4-3) = 60（退貨沖回原快照）',
  (select cost from product_movement(date '2099-04-01', date '2099-04-30') where product_id = pg_temp.vid('p1')), 60);
select pg_temp.t_num('C4 product_movement：沒有進貨',
  (select purchase_qty from product_movement(date '2099-04-01', date '2099-04-30') where product_id = pg_temp.vid('p1')), 0);

-- 整單折讓分攤：全退的淨額是 -900，不是 -1100
select pg_temp.mk('salx', 'sale', 'c4', date '2099-07-01', jsonb_build_array(pg_temp.li('p1', 10, 100)), 100, 0);
select pg_temp.mkret('rx', 'salx', jsonb_build_array(pg_temp.ri('salx','p1',10,100)), date '2099-07-02', 100, 0);
select pg_temp.t_num('C5 全退含整單折讓：退貨列淨額 -1000+100 = -900（不是 -1100）',
  (select sum(subtotal - coalesce(order_discount_alloc, 0)) from product_movement_base where order_id = pg_temp.vid('rx')), -900);
select pg_temp.t_num('C6 全退含整單折讓：order_total 為 -900', pg_temp.otot('rx'), -900);
select pg_temp.t_num('C7 全退後該月出貨淨額歸零',
  (select sale_amount from product_movement(date '2099-07-01', date '2099-07-31') where product_id = pg_temp.vid('p1')), 0);
select pg_temp.t_num('C8 全退後該月成本歸零',
  (select cost from product_movement(date '2099-07-01', date '2099-07-31') where product_id = pg_temp.vid('p1')), 0);

select pg_temp.t_num('C9 product_cost_detail_summary：淨出貨 270',
  (select sale_amount from product_cost_detail_summary(pg_temp.vid('p1'), date '2099-04-01', date '2099-04-30')), 270);
select pg_temp.t_num('C10 product_cost_detail_summary：淨件數 3',
  (select sale_qty from product_cost_detail_summary(pg_temp.vid('p1'), date '2099-04-01', date '2099-04-30')), 3);
select pg_temp.t_num('C11 product_cost_detail_summary：成本 60',
  (select cost from product_cost_detail_summary(pg_temp.vid('p1'), date '2099-04-01', date '2099-04-30')), 60);

select pg_temp.t_num('C12 product_cost_movements：4 月 3 列（作廢的 R3 不算）',
  (select count(*) from product_cost_movements(pg_temp.vid('p1'), date '2099-04-01', date '2099-04-30')), 3);
select pg_temp.t_num('C13 product_cost_movements：R1 subtotal 為負 -400',
  (select subtotal from product_cost_movements(pg_temp.vid('p1'), date '2099-04-01', date '2099-04-30')
   where order_no = (select order_no from orders where id = pg_temp.vid('r1'))), -400);
select pg_temp.t_txt('C14 product_cost_movements：R1 type',
  (select type from product_cost_movements(pg_temp.vid('p1'), date '2099-04-01', date '2099-04-30')
   where order_no = (select order_no from orders where id = pg_temp.vid('r1'))), 'sale_return');
select pg_temp.t_num('C15 product_cost_movements：SAL1 subtotal 仍為正 1000',
  (select subtotal from product_cost_movements(pg_temp.vid('p1'), date '2099-04-01', date '2099-04-30')
   where order_no = (select order_no from orders where id = pg_temp.vid('sal1'))), 1000);

-- 總覽：收益含稅（950-380-280 = 290）、成本 60、毛利 = 未稅淨額 270 - 60
select pg_temp.t_num('C16 dashboard_summary：revenue 290',
  (select revenue from dashboard_summary(date '2099-04-01', date '2099-04-30')), 290);
select pg_temp.t_num('C17 dashboard_summary：expense 0',
  (select expense from dashboard_summary(date '2099-04-01', date '2099-04-30')), 0);
select pg_temp.t_num('C18 dashboard_summary：cost 60',
  (select cost from dashboard_summary(date '2099-04-01', date '2099-04-30')), 60);
select pg_temp.t_num('C19 dashboard_summary：profit 210',
  (select profit from dashboard_summary(date '2099-04-01', date '2099-04-30')), 210);
-- 進貨退出算進支出（3 月：200+210-80 = 330；P3 的進退互相抵掉）
select pg_temp.t_num('C20 dashboard_summary：3 月 expense = 進貨 2000+200+210+50 - 進貨退出 80+50 = 2330',
  (select expense from dashboard_summary(date '2099-03-01', date '2099-03-31')), 2330);

select pg_temp.t_num('C21 cost_trend：4 月出貨淨額 270',
  (select sale_amount from cost_trend(date '2099-04-01', date '2099-04-30') where month = date '2099-04-01'), 270);
select pg_temp.t_num('C22 cost_trend：4 月毛利 210',
  (select estimated_profit from cost_trend(date '2099-04-01', date '2099-04-30') where month = date '2099-04-01'), 210);

-- 客戶毛利
select pg_temp.t_num('C23 partner_profit C1：淨額 270',
  (select sale_amount from partner_profit(date '2099-04-01', date '2099-04-30', null, pg_temp.vid('c1'))), 270);
select pg_temp.t_num('C24 partner_profit C1：成本 60',
  (select cost from partner_profit(date '2099-04-01', date '2099-04-30', null, pg_temp.vid('c1'))), 60);
select pg_temp.t_num('C25 partner_profit C1：毛利 210',
  (select profit from partner_profit(date '2099-04-01', date '2099-04-30', null, pg_temp.vid('c1'))), 210);
select pg_temp.t_num('C26 partner_profit C1：order_count 只算出貨單 = 1',
  (select order_count from partner_profit(date '2099-04-01', date '2099-04-30', null, pg_temp.vid('c1'))), 1);
select pg_temp.t_txt('C27 partner_profit C1：last_sale_date 是出貨日不是退貨日',
  (select last_sale_date::text from partner_profit(date '2099-04-01', date '2099-04-30', null, pg_temp.vid('c1'))), '2099-04-10');
select pg_temp.t_num('C28 partner_profit_products C1：淨件數 3',
  (select sale_qty from partner_profit_products(pg_temp.vid('c1'), date '2099-04-01', date '2099-04-30')
   where product_id = pg_temp.vid('p1')), 3);
select pg_temp.t_num('C29 partner_profit_products C1：毛利 210',
  (select profit from partner_profit_products(pg_temp.vid('c1'), date '2099-04-01', date '2099-04-30')
   where product_id = pg_temp.vid('p1')), 210);

-- 只有退貨、沒有出貨的客戶：5 月出貨、6 月退貨 → 6 月以負毛利出現
select pg_temp.mk('salc4', 'sale', 'c4', date '2099-05-20', jsonb_build_array(pg_temp.li('p1', 3, 100)));
select pg_temp.mkret('rc4', 'salc4', jsonb_build_array(pg_temp.ri('salc4','p1',2,100)), date '2099-06-10');
select pg_temp.t_num('C30 只有退貨的客戶：6 月 sale_amount -200',
  (select sale_amount from partner_profit(date '2099-06-01', date '2099-06-30', null, pg_temp.vid('c4'))), -200);
select pg_temp.t_num('C31 只有退貨的客戶：成本 -40',
  (select cost from partner_profit(date '2099-06-01', date '2099-06-30', null, pg_temp.vid('c4'))), -40);
select pg_temp.t_num('C32 只有退貨的客戶：毛利 -160',
  (select profit from partner_profit(date '2099-06-01', date '2099-06-30', null, pg_temp.vid('c4'))), -160);
select pg_temp.t_num('C33 只有退貨的客戶：order_count 0',
  (select order_count from partner_profit(date '2099-06-01', date '2099-06-30', null, pg_temp.vid('c4'))), 0);
select pg_temp.t_ok('C34 只有退貨的客戶：last_sale_date 為 null',
  (select last_sale_date is null from partner_profit(date '2099-06-01', date '2099-06-30', null, pg_temp.vid('c4'))));

-- 對帳單：退貨明細 qty、subtotal 為負，type 追加在尾端
select pg_temp.t_num('C35 statement_line_view：C1 共 3 列（R3 作廢、草稿不入）',
  (select count(*) from statement_line_view where partner_id = pg_temp.vid('c1')), 3);
select pg_temp.t_num('C36 statement_line_view：R1 qty -4',
  (select qty from statement_line_view where order_id = pg_temp.vid('r1')), -4);
select pg_temp.t_num('C37 statement_line_view：R1 subtotal -400',
  (select subtotal from statement_line_view where order_id = pg_temp.vid('r1')), -400);
select pg_temp.t_txt('C38 statement_line_view：R1 type',
  (select type from statement_line_view where order_id = pg_temp.vid('r1')), 'sale_return');
select pg_temp.t_num('C39 statement_line_view：SAL1 qty 10（出貨不變）',
  (select qty from statement_line_view where order_id = pg_temp.vid('sal1')), 10);
select pg_temp.t_txt('C40 statement_line_view：SAL1 type',
  (select type from statement_line_view where order_id = pg_temp.vid('sal1')), 'sale');
select pg_temp.t_num('C41 statement_summary C1 4 月：current_sales 1000-400-300 = 300',
  (select current_sales from statement_summary(date '2099-04-01', date '2099-04-30') where id = pg_temp.vid('c1')), 300);
select pg_temp.t_num('C42 statement_summary C1 4 月：total_balance 300',
  (select total_balance from statement_summary(date '2099-04-01', date '2099-04-30') where id = pg_temp.vid('c1')), 300);

-- 餘額：退貨在退貨日那一期才減掉
select pg_temp.t_num('C43 partner_balance_view C1：total_sales 950-380-280 = 290',
  (select total_sales from partner_balance_view where id = pg_temp.vid('c1')), 290);
select pg_temp.t_num('C44 partner_balance_view C1：balance 290',
  (select balance from partner_balance_view where id = pg_temp.vid('c1')), 290);
select pg_temp.t_num('C45 get_partner_balances 截至退貨前（04-12）：950',
  (select total_sales from get_partner_balances(date '2099-04-12', pg_temp.vid('c1'))), 950);
select pg_temp.t_num('C46 get_partner_balances 截至 R1 當日（04-15）：570',
  (select total_sales from get_partner_balances(date '2099-04-15', pg_temp.vid('c1'))), 570);
select pg_temp.t_num('C47 get_partner_balances 不限日期：290',
  (select balance from get_partner_balances(null, pg_temp.vid('c1'))), 290);

-- ============================================================
-- D. 收付款：退貨抵扣、0 元沖帳、部分抵扣
-- ============================================================

-- ---- D-1 客戶 C2：淨額等於收款金額（出貨 500、退貨 -200、實收 300）
select pg_temp.mk('sald', 'sale', 'c2', date '2099-05-05', jsonb_build_array(pg_temp.li('p1', 5, 100)));
select pg_temp.mkret('rd', 'sald', jsonb_build_array(pg_temp.ri('sald','p1',2,100)), date '2099-05-06');
select pg_temp.t_num('D1 退貨單金額 -200', pg_temp.otot('rd'), -200);
select pg_temp.t_num('D2 C2 收款前餘額 500-200 = 300',
  (select balance from get_partner_balances(null, pg_temp.vid('c2'))), 300);

select pg_temp.t_runs('D3 淨額 300 = 收款 300 可存',
  $q$ select pg_temp.reg('pay1', save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-08', 300, 'cash', null,
        pg_temp.allocs('[["sald", 500], ["rd", -200]]'::jsonb))) $q$);
select pg_temp.t_txt('D4 出貨單 SALD 已付清',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('sald')), 'paid');
select pg_temp.t_num('D5 退貨單 RD paid_amount -200',
  (select paid_amount from order_payment_summary_view where order_id = pg_temp.vid('rd')), -200);
select pg_temp.t_num('D6 退貨單 RD outstanding 0',
  (select outstanding_amount from order_payment_summary_view where order_id = pg_temp.vid('rd')), 0);
select pg_temp.t_txt('D7 退貨單 RD 狀態 paid（已抵扣）',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('rd')), 'paid');
select pg_temp.t_txt('D8 search_view：RD payment_status paid',
  (select payment_status from order_search_view where id = pg_temp.vid('rd')), 'paid');
select pg_temp.t_num('D9 get_partner_balances C2：total_sales 300',
  (select total_sales from get_partner_balances(null, pg_temp.vid('c2'))), 300);
select pg_temp.t_num('D10 get_partner_balances C2：total_paid 300',
  (select total_paid from get_partner_balances(null, pg_temp.vid('c2'))), 300);
select pg_temp.t_num('D11 get_partner_balances C2：total_allocated 300（500 + -200）',
  (select total_allocated from get_partner_balances(null, pg_temp.vid('c2'))), 300);
select pg_temp.t_num('D12 get_partner_balances C2：unallocated_credit 0',
  (select unallocated_credit from get_partner_balances(null, pg_temp.vid('c2'))), 0);
select pg_temp.t_num('D13 get_partner_balances C2：balance 0',
  (select balance from get_partner_balances(null, pg_temp.vid('c2'))), 0);

-- ---- D-2 0 元沖帳單（換貨：新出貨 200、退貨 -200，沒有現金進出）
select pg_temp.mk('sale2', 'sale', 'c2', date '2099-05-06', jsonb_build_array(pg_temp.li('p1', 2, 100)));
select pg_temp.mkret('re', 'sald', jsonb_build_array(pg_temp.ri('sald','p1',2,100)), date '2099-05-07');

select pg_temp.t_raises('D14 0 元收款且沒有分配被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 0, 'cash', null, '[]'::jsonb) $q$,
  'PAYMENT_AMOUNT_INVALID');
select pg_temp.t_raises('D15 0 元收款但淨額 ≠ 0（只沖出貨 +200）被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 0, 'cash', null,
        pg_temp.allocs('[["sale2", 200]]'::jsonb)) $q$,
  'PAYMENT_AMOUNT_INVALID');
select pg_temp.t_raises('D16 0 元收款但淨額 < 0（只沖退貨 -200）被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 0, 'cash', null,
        pg_temp.allocs('[["re", -200]]'::jsonb)) $q$,
  'PAYMENT_AMOUNT_INVALID');
select pg_temp.t_raises('D17 收款金額為負被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', -1, 'cash', null, '[]'::jsonb) $q$,
  'PAYMENT_AMOUNT_INVALID');
select pg_temp.t_raises('D18 淨額為負（收 100、只沖退貨 -200）被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 100, 'cash', null,
        pg_temp.allocs('[["re", -200]]'::jsonb)) $q$,
  'ALLOCATION_NET_NEGATIVE');
select pg_temp.t_raises('D19 單筆分配金額為 0 被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 0, 'cash', null,
        pg_temp.allocs('[["sale2", 0]]'::jsonb)) $q$,
  'ALLOCATION_AMOUNT_INVALID');
select pg_temp.t_raises('D20 退貨單上放正的分配（正負號與單據不一致）被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 200, 'cash', null,
        pg_temp.allocs('[["re", 200]]'::jsonb)) $q$,
  'ALLOCATION_AMOUNT_INVALID');
select pg_temp.mk('sale3', 'sale', 'c2', date '2099-05-06', jsonb_build_array(pg_temp.li('p1', 1, 100)));
select pg_temp.t_raises('D21 出貨單上放負的分配被擋（不能用負數抵掉別張單的分配，淨額雖為 0 仍不行）',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 0, 'cash', null,
        pg_temp.allocs('[["sale3", 100], ["sale2", -100]]'::jsonb)) $q$,
  'ALLOCATION_AMOUNT_INVALID');
select pg_temp.t_raises('D22 客戶收款沖進貨退出單：方向不符被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 100, 'cash', null,
        pg_temp.allocs('[["sale2", 100], ["pr1", -80]]'::jsonb)) $q$,
  'ALLOCATION_DIRECTION_MISMATCH');

select pg_temp.t_runs('D23 0 元沖帳單：+200 與 -200 淨額 0 可存',
  $q$ select pg_temp.reg('pay0', save_payment_with_allocations(pg_temp.vid('c2'), date '2099-05-09', 0, 'cash', '換貨沖帳',
        pg_temp.allocs('[["sale2", 200], ["re", -200]]'::jsonb))) $q$);
select pg_temp.t_num('D24 0 元沖帳單 payments.amount = 0',
  (select amount from payments where id = pg_temp.vid('pay0')), 0);
select pg_temp.t_txt('D25 換貨的新出貨單 paid',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('sale2')), 'paid');
select pg_temp.t_txt('D26 換貨的退貨單 paid',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('re')), 'paid');

-- ---- D-3 客戶 C3：部分抵扣（出貨 +150、退貨 -300，同一張退貨分兩筆抵完）
select pg_temp.mk('salg', 'sale', 'c3', date '2099-05-10', jsonb_build_array(pg_temp.li('p1', 3, 50)));
select pg_temp.mk('salh', 'sale', 'c3', date '2099-05-11', jsonb_build_array(pg_temp.li('p1', 6, 50)));
select pg_temp.mkret('rg', 'salh', jsonb_build_array(pg_temp.ri('salh','p1',6,50)), date '2099-05-12');
select pg_temp.mk('sali', 'sale', 'c3', date '2099-05-12', jsonb_build_array(pg_temp.li('p1', 2, 50)));
select pg_temp.mkret('ri', 'sali', jsonb_build_array(pg_temp.ri('sali','p1',2,50)), date '2099-05-13');

select pg_temp.t_runs('D27 部分抵扣：出貨 +150 抵退貨 -150（退貨只抵一半）',
  $q$ select pg_temp.reg('pg1', save_payment_with_allocations(pg_temp.vid('c3'), date '2099-05-14', 0, 'cash', null,
        pg_temp.allocs('[["salg", 150], ["rg", -150]]'::jsonb))) $q$);
select pg_temp.t_txt('D28 RG 第一筆後 partial',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('rg')), 'partial');
select pg_temp.t_num('D29 RG 第一筆後 outstanding -150',
  (select outstanding_amount from order_payment_summary_view where order_id = pg_temp.vid('rg')), -150);
select pg_temp.t_txt('D30 SALG 已付清',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('salg')), 'paid');

-- 列表與待沖清單
select pg_temp.t_txt('D31 search_order_groups：RG 組 partial、金額為負',
  (select payment_status || ':' || total_amount::text
   from search_order_groups(null, null, null, null, null, 'VT030 客戶3', 50, 0)
   where group_root_id = pg_temp.vid('rg')), 'partial:-300.00');
select pg_temp.t_ok('D32 search_order_groups：篩「未結清」撈得到部分抵扣的 RG',
  exists (select 1 from search_order_groups(null, null, null, null, 'outstanding', 'VT030 客戶3', 50, 0)
          where group_root_id = pg_temp.vid('rg')));
select pg_temp.t_txt('D33 search_order_groups：尚未抵扣的 RI 組 unpaid',
  (select payment_status from search_order_groups(null, null, null, null, null, 'VT030 客戶3', 50, 0)
   where group_root_id = pg_temp.vid('ri')), 'unpaid');
select pg_temp.t_num('D34 search_order_groups：只篩銷貨退回 → C3 有 RG、RI 兩組',
  (select count(*) from search_order_groups(null, null, 'sale_return', null, null, 'VT030 客戶3', 50, 0)), 2);
select pg_temp.t_num('D35 search_order_groups：退貨單自成一組，原單組 SALH 的合計仍是 +300',
  (select total_amount from search_order_groups(null, null, 'sale', null, null, 'VT030 客戶3', 50, 0)
   where group_root_id = pg_temp.vid('salh')), 300);
select pg_temp.t_num('D36 outstanding_order_view：RG outstanding -150（待抵扣額度）',
  (select outstanding_amount from outstanding_order_view where id = pg_temp.vid('rg')), -150);
select pg_temp.t_ok('D37 unpaid_order_view 看不到退貨單（舊前端相容）',
  not exists (select 1 from unpaid_order_view where id = pg_temp.vid('rg') or id = pg_temp.vid('ri')));
select pg_temp.t_num('D38 unpaid_order_view 仍有未收的出貨單 SALI +100',
  (select order_total from unpaid_order_view where id = pg_temp.vid('sali')), 100);

select pg_temp.t_runs('D39 第二筆：SALH +150 抵 RG 剩下的 -150',
  $q$ select pg_temp.reg('pg2', save_payment_with_allocations(pg_temp.vid('c3'), date '2099-05-15', 0, 'cash', null,
        pg_temp.allocs('[["salh", 150], ["rg", -150]]'::jsonb))) $q$);
select pg_temp.t_txt('D40 RG 第二筆後 paid',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('rg')), 'paid');
select pg_temp.t_txt('D41 SALH 只收一半 → partial',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('salh')), 'partial');
select pg_temp.t_txt('D42 search_order_groups：RG 組 paid',
  (select payment_status from search_order_groups(null, null, null, null, null, 'VT030 客戶3', 50, 0)
   where group_root_id = pg_temp.vid('rg')), 'paid');
select pg_temp.t_raises('D43 兩筆合計超過退貨金額被擋（-300 之外再抵 -10）',
  $q$ select save_payment_with_allocations(pg_temp.vid('c3'), date '2099-05-16', 0, 'cash', null,
        pg_temp.allocs('[["salh", 10], ["rg", -10]]'::jsonb)) $q$,
  'ALLOCATION_EXCEEDS_ORDER');
select pg_temp.t_raises('D44 淨額為負（C3：收 100、只沖退貨 RI -100）被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c3'), date '2099-05-16', 100, 'cash', null,
        pg_temp.allocs('[["ri", -100]]'::jsonb)) $q$,
  'ALLOCATION_NET_NEGATIVE');
select pg_temp.t_raises('D45 分配超過收款金額（收 50、沖 +100）仍被擋',
  $q$ select save_payment_with_allocations(pg_temp.vid('c3'), date '2099-05-16', 50, 'cash', null,
        pg_temp.allocs('[["sali", 100]]'::jsonb)) $q$,
  'ALLOCATION_EXCEEDS_PAYMENT');
select pg_temp.t_raises('D46 供應商不可沖客戶的退貨單（對象類型不符）',
  $q$ select save_payment_with_allocations(pg_temp.vid('s1'), date '2099-05-16', 0, 'cash', null,
        pg_temp.allocs('[["sali", 100], ["ri", -100]]'::jsonb)) $q$,
  'ALLOCATION_DIRECTION_MISMATCH');

select pg_temp.t_num('D47 payment_allocation_view：第一筆對 RG 的分配 -150',
  (select allocated_amount from payment_allocation_view where payment_id = pg_temp.vid('pg1') and order_id = pg_temp.vid('rg')), -150);
select pg_temp.t_num('D48 payment_allocation_view：RG order_total -300',
  (select order_total from payment_allocation_view where payment_id = pg_temp.vid('pg1') and order_id = pg_temp.vid('rg')), -300);

-- 預收款（沒有分配）照舊可存
select pg_temp.t_runs('D49 預收款（金額 50、無分配）可存',
  $q$ select pg_temp.reg('prepay', save_payment_with_allocations(pg_temp.vid('c3'), date '2099-05-17', 50, 'cash', null, '[]'::jsonb)) $q$);
select pg_temp.t_num('D50 C3 預收款：unallocated_credit 50',
  (select unallocated_credit from get_partner_balances(null, pg_temp.vid('c3'))), 50);
select pg_temp.t_num('D51 C3：total_sales 150+300-300+100-100 = 150',
  (select total_sales from get_partner_balances(null, pg_temp.vid('c3'))), 150);
select pg_temp.t_num('D52 C3：balance 150 - 50 = 100',
  (select balance from get_partner_balances(null, pg_temp.vid('c3'))), 100);

-- 繞過 RPC 直接改表
select pg_temp.t_raises('D53 直接把收款金額改負數：payments_amount_check',
  $q$ update payments set amount = -1 where id = pg_temp.vid('prepay') $q$, 'payments_amount_check');
select pg_temp.t_raises('D54 直接把無分配的收款改成 0：payments 端 trigger 擋下',
  $q$ update payments set amount = 0 where id = pg_temp.vid('prepay') $q$, 'PAYMENT_AMOUNT_INVALID');
select pg_temp.t_raises('D55 直接插入金額 0 的分配列：payment_orders_amount_nonzero',
  $q$ insert into payment_orders (payment_id, order_id, amount)
      values (pg_temp.vid('pg1'), pg_temp.vid('sali'), 0) $q$,
  'payment_orders_amount_nonzero');

-- 已沖帳單據的保護
select pg_temp.t_raises('D56 已被抵扣的退貨單不可作廢',
  $q$ select void_order(pg_temp.vid('rd')) $q$, 'ORDER_HAS_ALLOCATIONS');
select pg_temp.t_raises('D57 已被抵扣的退貨單金額不可改到低於已沖（-200 → 150）',
  $q$ update orders set discount = 50 where id = pg_temp.vid('rd') $q$, 'ORDER_TOTAL_BELOW_ALLOCATED');
select pg_temp.t_runs('D58 已沖帳單據改備註仍可（金額沒變）',
  $q$ update orders set note = 'VT030 改備註' where id = pg_temp.vid('rd') $q$);

-- ---- D-4 供應商 S2：進貨 200、進貨退出 -80，實付 120
select pg_temp.mk('pur5', 'purchase', 's2', date '2099-05-01', jsonb_build_array(pg_temp.li('p1', 10, 20)));
select pg_temp.mkret('pr5', 'pur5', jsonb_build_array(pg_temp.ri('pur5','p1',4,20)), date '2099-05-02');
select pg_temp.t_num('D59 S2 付款前應付 200-80 = 120',
  (select balance from get_partner_balances(null, pg_temp.vid('s2'), false, null, 'supplier')), 120);
select pg_temp.t_raises('D64 供應商付款不可沖銷貨退回單（方向不符）',
  $q$ select save_payment_with_allocations(pg_temp.vid('s2'), date '2099-05-19', 100, 'cash', null,
        pg_temp.allocs('[["pur5", 100], ["rc4", -80]]'::jsonb)) $q$,
  'ALLOCATION_DIRECTION_MISMATCH');
select pg_temp.t_runs('D60 付款 120 沖進貨 +200 與進貨退出 -80',
  $q$ select pg_temp.reg('pays2', save_payment_with_allocations(pg_temp.vid('s2'), date '2099-05-18', 120, 'transfer', null,
        pg_temp.allocs('[["pur5", 200], ["pr5", -80]]'::jsonb))) $q$);
select pg_temp.t_num('D61 S2 付款後應付 0',
  (select balance from get_partner_balances(null, pg_temp.vid('s2'), false, null, 'supplier')), 0);
select pg_temp.t_num('D62 S2 total_sales（進貨總額，含退出）120',
  (select total_sales from get_partner_balances(null, pg_temp.vid('s2'), false, null, 'supplier')), 120);
select pg_temp.t_txt('D63 進貨退出單 PR5 paid',
  (select payment_status from order_payment_summary_view where order_id = pg_temp.vid('pr5')), 'paid');

-- ============================================================
-- E. 作廢限制
-- ============================================================
select pg_temp.t_raises('E1 原單有有效退貨單，不可作廢',
  $q$ select void_order(pg_temp.vid('sal1')) $q$, 'ORDER_HAS_RETURNS');

-- 作廢銷貨退回單要檢查庫存：退回的貨已經又賣出去
select pg_temp.mk('pur6', 'purchase', 's1', date '2099-03-01', jsonb_build_array(pg_temp.li('p4', 5, 10)));
select pg_temp.mk('sal6', 'sale', 'c4', date '2099-03-02', jsonb_build_array(pg_temp.li('p4', 5, 20)));
select pg_temp.mkret('rsr', 'sal6', jsonb_build_array(pg_temp.ri('sal6','p4',5,20)), date '2099-03-03');
select pg_temp.mk('sal7', 'sale', 'c4', date '2099-03-04', jsonb_build_array(pg_temp.li('p4', 5, 20)));
select pg_temp.t_num('E2 P4 庫存已被賣光', pg_temp.stock('p4'), 0);
select pg_temp.t_raises('E3 作廢銷貨退回單會讓庫存變負數，被擋',
  $q$ select void_order(pg_temp.vid('rsr')) $q$, 'RETURN_STOCK_INSUFFICIENT');
select pg_temp.t_txt('E4 被擋後退貨單狀態不變',
  (select status from orders where id = pg_temp.vid('rsr')), 'confirmed');

-- 作廢進貨退出：把貨加回庫存，不需檢查，均價回到退貨前
select pg_temp.t_runs('E5 作廢進貨退出單 PR1', $q$ select void_order(pg_temp.vid('pr1')) $q$);
select pg_temp.t_num('E6 作廢後庫存回補（2 → 6）', pg_temp.stock('p2'), 6);
select pg_temp.t_num('E7 作廢後均價回到 20.5',
  purchase_avg_cost_asof(pg_temp.vid('p2'), date '2099-12-31'), 20.5);

-- 作廢退貨單後，可退數量釋回
select pg_temp.t_runs('E8 作廢 R2', $q$ select void_order(pg_temp.vid('r2')) $q$);
select pg_temp.t_num('E9 作廢後 SAL1 return_count = 1',
  (select return_count from order_search_view where id = pg_temp.vid('sal1')), 1);
select pg_temp.t_raises('E10 已退 4，剩 6：再退 7 仍被擋',
  $q$ select pg_temp.mkret('x', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',7,100)), date '2099-04-22') $q$,
  'RETURN_QTY_EXCEEDS');
select pg_temp.t_runs('E11 作廢的退貨數量釋回：可再退 6',
  $q$ select pg_temp.mkret('r4', 'sal1', jsonb_build_array(pg_temp.ri('sal1','p1',6,100)), date '2099-04-22') $q$);
select pg_temp.t_raises('E12 仍有有效退貨單（R1、R4），原單不可作廢',
  $q$ select void_order(pg_temp.vid('sal1')) $q$, 'ORDER_HAS_RETURNS');
select pg_temp.t_runs('E13a 作廢 R1', $q$ select void_order(pg_temp.vid('r1')) $q$);
select pg_temp.t_runs('E13b 作廢 R4', $q$ select void_order(pg_temp.vid('r4')) $q$);
select pg_temp.t_runs('E13c 退貨單全部作廢後，原單可作廢', $q$ select void_order(pg_temp.vid('sal1')) $q$);
select pg_temp.t_txt('E14 SAL1 已作廢', (select status from orders where id = pg_temp.vid('sal1')), 'void');

-- ============================================================
-- 結果
-- ============================================================
select n, case when ok then 'PASS' else 'FAIL' end as result, name, detail
from vlog
order by n;

select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed, count(*) as total
from vlog;

do $$
declare
  v_failed int;
begin
  select count(*) into v_failed from vlog where not ok;
  if v_failed > 0 then
    raise exception 'verify-030 有 % 個案例失敗，見上方 FAIL 列', v_failed;
  end if;
end $$;

rollback;
