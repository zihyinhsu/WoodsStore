const fs = require('fs');
const path = require('path');
const { launch, goto, Results } = require('./helpers');

// 這支測試把「退貨相關」的查詢全部 page.route 攔下來回假資料：.env 指向的開發庫還沒有退貨的 schema
// （order_search_view 沒有 return_of_order_no、沒有 create_return_order），直接打會整頁壞掉。
// 寫入一律由這裡接住並記錄 body，絕不會送到資料庫；helpers.launch() 的寫入攔截仍是第二道保險。

const GOLDEN_FILE = path.join(__dirname, 'fixtures', 'shipping-slip.golden.html');
// 重新產生黃金檔：只在「確定出貨單版面要改」時才用，平常看到版面差異就是 bug。
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';
const GOLDEN_ONLY = process.env.GOLDEN_ONLY === '1';

// ---------- 假資料 ----------

const PARTNER = { id: 'p-1', partner_no: 'C001', name: '測試客戶', tax_id: '12345678', phone: '0912-345-678', type: 'customer', address: '台北市' };
const SUPPLIER = { id: 'p-2', partner_no: 'S001', name: '測試供應商', tax_id: '', phone: '', type: 'supplier', address: '' };

const orderRow = (over) => ({
  id: 'x', order_no: 'X', type: 'sale', status: 'confirmed', order_date: '2026-11-01',
  partner_id: 'p-1', partner_name: '測試客戶', top_item_name: '矽利康', item_count: 2,
  total_amount: 0, discount: 0, tax: 0, payment_status: 'unpaid', paid_amount: 0,
  parent_order_id: null, group_root_no: null, group_size: 1, note: '',
  return_of_order_id: null, return_of_order_no: null, return_count: 0,
  created_at: '2026-11-01T01:00:00Z',
  ...over
});

const ORDERS = [
  // 原出貨單：兩列明細，原價 1000 + 1800（含 10% 明細折扣）= 2800，整單折讓 100、稅 50
  orderRow({ id: 'ord-s1', order_no: 'ORD-S1', total_amount: 2750, discount: 100, tax: 50, return_count: 1 }),
  orderRow({ id: 'ord-d1', order_no: 'ORD-D1', status: 'draft', total_amount: 500, payment_status: null }),
  orderRow({ id: 'ord-v1', order_no: 'ORD-V1', status: 'void', total_amount: 500, payment_status: null }),
  orderRow({ id: 'ord-p1', order_no: 'ORD-P1', type: 'purchase', partner_id: 'p-2', partner_name: '測試供應商', total_amount: 900 }),
  orderRow({ id: 'ord-a1', order_no: 'ORD-A1', type: 'adjust', partner_id: null, partner_name: null, total_amount: 0, payment_status: null }),
  // 退貨單：total_amount 為負，payment_status 對應 未抵扣／部分抵扣／已抵扣
  orderRow({
    id: 'rtn-1', order_no: 'RTN-1', type: 'sale_return', total_amount: -760,
    return_of_order_id: 'ord-s1', return_of_order_no: 'ORD-S1', payment_status: 'unpaid'
  }),
  orderRow({
    id: 'rtn-2', order_no: 'RTN-2', type: 'purchase_return', partner_id: 'p-2', partner_name: '測試供應商',
    total_amount: -300, return_of_order_id: 'ord-p1', return_of_order_no: 'ORD-P1', payment_status: 'partial', paid_amount: -50
  }),
  orderRow({
    id: 'rtn-3', order_no: 'RTN-3', type: 'sale_return', total_amount: -100,
    return_of_order_id: 'ord-s1', return_of_order_no: 'ORD-S1', payment_status: 'paid', paid_amount: -100
  })
];

const product = (id, name, spec) => ({ id, name, sku: `SKU-${id}`, spec, unit: '支' });
const P1 = product('pr-1', '矽利康', '白色');
const P2 = product('pr-2', '油漆', '5加侖');

const item = (id, order_id, products, over) => ({
  id, order_id, product_id: products.id, products, discount: 0, return_of_item_id: null, ...over
});

const ITEMS = [
  item('i-1', 'ord-s1', P1, { qty: -10, unit_price: 100, subtotal: 1000 }),
  item('i-2', 'ord-s1', P2, { qty: -5, unit_price: 400, discount: 10, subtotal: 1800 }),
  item('i-3', 'ord-p1', P1, { qty: 9, unit_price: 100, subtotal: 900 }),
  // 銷貨退回單 RTN-1：庫存 +，subtotal 恆為正（生成欄位 abs(qty)）
  item('r-1', 'rtn-1', P1, { qty: 4, unit_price: 100, subtotal: 400, return_of_item_id: 'i-1' }),
  item('r-2', 'rtn-1', P2, { qty: 1, unit_price: 400, discount: 10, subtotal: 360, return_of_item_id: 'i-2' })
];

// 原單 ORD-S1 已退：i-1 退 4、i-2 退 1；那張退貨單帶走折讓 20、稅 10
const RETURNED_ITEMS = [
  { return_of_item_id: 'i-1', qty: 4, orders: { status: 'confirmed' } },
  { return_of_item_id: 'i-2', qty: 1, orders: { status: 'confirmed' } }
];
const RETURN_ORDERS_OF_S1 = [{ id: 'rtn-1', discount: 20, tax: 10 }];

// 合併分批：兩批確認、一批作廢，只有確認的批次該有退貨鈕
const BATCH_ORDERS = [
  orderRow({ id: 'ord-b1', order_no: 'ORD-B1', type: 'purchase', partner_id: 'p-2', partner_name: '測試供應商', total_amount: 500, group_root_no: 'ORD-B1', group_size: 3 }),
  orderRow({ id: 'ord-b2', order_no: 'ORD-B2', type: 'purchase', partner_id: 'p-2', partner_name: '測試供應商', total_amount: 600, parent_order_id: 'ord-b1', group_root_no: 'ORD-B1', group_size: 3 }),
  orderRow({ id: 'ord-b3', order_no: 'ORD-B3', type: 'purchase', status: 'void', partner_id: 'p-2', partner_name: '測試供應商', total_amount: 700, parent_order_id: 'ord-b1', group_root_no: 'ORD-B1', group_size: 3, payment_status: null })
];
const BATCH_ITEMS = BATCH_ORDERS.map((o, i) => item(`b-${i}`, o.id, P1, { qty: 5, unit_price: 100, subtotal: 500 }));

// ---------- 攔截 ----------

function installMocks(page, state) {
  return page.route('**/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.split('/rest/v1/')[1];
    const q = url.searchParams;
    const ok = (body, total) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      // 跨網域的 fetch 讀不到沒被 expose 的 header；少了這行 supabase-js 拿不到總筆數，
      // 列表會誤以為沒有資料。
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'content-range',
        ...(total === undefined ? {} : { 'content-range': `0-${Math.max(total - 1, 0)}/${total}` })
      },
      body: JSON.stringify(body)
    });
    const idsOf = (param) => (q.get(param) || '').replace(/^(in\.\(|eq\.)|\)$/g, '').split(',').filter(Boolean);
    state.requests.push(`${req.method()} ${name}`);

    if (req.method() === 'POST' && name === 'rpc/create_return_order') {
      state.createCalls.push(JSON.parse(req.postData()));
      const fail = state.createError;
      if (fail) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: fail }) });
      }
      return ok('00000000-0000-0000-0000-0000000000aa');
    }

    if (req.method() === 'GET') {
      // 退貨視窗查歷次退貨的折讓／稅額：直接查 orders，不走 order_search_view
      if (name === 'orders' && (q.get('return_of_order_id') || '').startsWith('eq.')) {
        return ok(state.returnOrders, state.returnOrders.length);
      }
      if (name === 'order_search_view') {
        state.searches.push(url.search);
        const ids = idsOf('id');
        if (ids.length) return ok(state.orders.filter(o => ids.includes(o.id)));
        return ok(state.orders, state.orders.length);
      }
      if (name === 'order_items') {
        state.itemQueries.push(url.search);
        // 已退數量的查詢：用 orders!inner 內嵌篩選原單，與一般取明細的查詢分開
        if ((q.get('select') || '').includes('orders!inner')) return ok(state.returnedItems);
        return ok(ITEMS.concat(BATCH_ITEMS).filter(i => idsOf('order_id').includes(i.order_id)));
      }
      if (name === 'partners') return ok([PARTNER, SUPPLIER]);
      if (name === 'partner_balance_view') return ok([{ id: 'p-1', balance: 5000 }]);
      if (name === 'stock_view') return ok(state.stock, state.stock.length);
      if (name === 'statement_line_view') return ok(state.statementLines);
    }

    if (req.method() === 'POST') {
      if (name === 'rpc/search_order_groups') return ok(state.groups);
      if (name === 'rpc/statement_summary') return ok(state.statementSummary);
      if (name === 'rpc/product_cost_detail_summary') return ok(state.costSummary);
      if (name === 'rpc/product_cost_movements') return ok(state.movements, state.movements.length);
    }

    return route.fallback();
  });
}

const newState = () => ({
  requests: [], searches: [], itemQueries: [], createCalls: [], createError: null,
  orders: ORDERS.concat(BATCH_ORDERS),
  returnOrders: RETURN_ORDERS_OF_S1,
  returnedItems: RETURNED_ITEMS,
  groups: [{
    group_root_id: 'ord-b1', group_root_no: 'ORD-B1', order_date: '2026-11-01', type: 'purchase',
    partner_name: '測試供應商', total_amount: 1100, payment_status: 'unpaid', paid_amount: 0,
    member_ids: ['ord-b1', 'ord-b2', 'ord-b3'], total_count: 1
  }],
  stock: [{ id: 'pr-1', sku: 'SKU-1', name: '矽利康', spec: '白色', unit: '支', category: '', location: '', stock_qty: 10, safety_stock: 1, cost: 50, price: 100, is_active: true }],
  statementSummary: [{
    id: 'p-1', partner_no: 'C001', name: '測試客戶', tax_id: '', phone: '', address: '',
    prev_balance: 0, prev_paid: 0, current_sales: 1000, current_paid: 0, total_balance: 700
  }],
  statementLines: [
    { partner_id: 'p-1', order_date: '2026-11-01', order_no: 'ORD-S1', type: 'sale', product_name: '矽利康', spec: '', qty: 10, unit: '支', unit_price: 100, subtotal: 1000 },
    { partner_id: 'p-1', order_date: '2026-11-05', order_no: 'RTN-1', type: 'sale_return', product_name: '矽利康', spec: '', qty: -3, unit: '支', unit_price: 100, subtotal: -300 }
  ],
  costSummary: [{ purchase_qty: 0, purchase_amount: 0, sale_qty: 7, sale_amount: 700, cost: 350 }],
  movements: [
    { order_date: '2026-11-01', order_no: 'ORD-S1', type: 'sale', qty: -10, subtotal: 1000, item_id: 'a' },
    { order_date: '2026-11-05', order_no: 'RTN-1', type: 'sale_return', qty: 3, subtotal: -300, item_id: 'b' },
    { order_date: '2026-11-06', order_no: 'RTN-2', type: 'purchase_return', qty: -2, subtotal: -200, item_id: 'c' }
  ]
});

// ---------- 小工具 ----------

const rowOf = (page, id) => page.locator(`#orders-table tr.clickable-row[data-id="${id}"]`);
const slipHtmlOf = (page) => page.evaluate(() => document.getElementById('print-area').innerHTML);
const stubPrint = (page) => page.evaluate(() => { window.print = () => {}; });
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

async function printSelected(page, ids) {
  for (const id of ids) await rowOf(page, id).locator('.print-pick').click();
  await page.click('#btn-print-selected');
  await page.waitForTimeout(1500);
}

const lineRow = (page, itemId) => page.locator(`#return-lines tbody tr[data-item-id="${itemId}"]`);
async function setLine(page, itemId, { qty, price }) {
  const row = lineRow(page, itemId);
  if (qty !== undefined) { await row.locator('.rt-qty').fill(String(qty)); await row.locator('.rt-qty').blur(); }
  if (price !== undefined) { await row.locator('.rt-price').fill(String(price)); await row.locator('.rt-price').blur(); }
}

(async () => {
  const r = new Results('退貨：單據頁、列印、對帳單、商品明細');
  const { browser, page, errors, blockedWrites } = await launch();
  const state = newState();
  await installMocks(page, state);

  const ordersUrl = 'orders.html?view=flat&status=all&from=2000-01-01&to=2035-12-31';
  await goto(page, ordersUrl);
  await stubPrint(page);

  // ===== 出貨單列印版面必須與退貨功能上線前逐位元組相同 =====
  // 黃金檔是用退貨功能上線前的 shippingSlipHtml 在同一份假資料上印出來的（見 UPDATE_GOLDEN）。
  // 不只檢查幾個欄位：欄位檢查抓不到多一個空白或換行，而複寫紙的版面是照這份 HTML 排的。
  await printSelected(page, ['ord-s1']);
  const shippingHtml = await slipHtmlOf(page);
  if (UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, shippingHtml);
    r.info('已寫入黃金檔', GOLDEN_FILE);
  } else {
    r.truthy('出貨單版面與黃金檔逐位元組相同', shippingHtml === fs.readFileSync(GOLDEN_FILE, 'utf8'));
  }

  if (GOLDEN_ONLY) {
    await browser.close();
    return;
  }
  const golden = fs.readFileSync(GOLDEN_FILE, 'utf8');

  // ===== 退貨按鈕只出現在已確認的進貨／出貨單 =====
  const hasReturnBtn = async (id) => (await rowOf(page, id).locator('.btn-return').count()) > 0;
  r.check('已確認出貨單有退貨鈕', await hasReturnBtn('ord-s1'), true);
  r.check('已確認進貨單有退貨鈕', await hasReturnBtn('ord-p1'), true);
  r.check('草稿沒有退貨鈕', await hasReturnBtn('ord-d1'), false);
  r.check('作廢單沒有退貨鈕', await hasReturnBtn('ord-v1'), false);
  r.check('調整單沒有退貨鈕', await hasReturnBtn('ord-a1'), false);
  r.check('銷貨退回單沒有退貨鈕', await hasReturnBtn('rtn-1'), false);
  r.check('進貨退出單沒有退貨鈕', await hasReturnBtn('rtn-2'), false);

  // ===== 類型徽章、抵扣標籤、互連 =====
  r.check('銷貨退回徽章', await textOf(rowOf(page, 'rtn-1').locator('.badge-red').first()), '銷貨退回');
  r.check('進貨退出徽章（朱紅）', await textOf(rowOf(page, 'rtn-2').locator('.badge-orange-red')), '進貨退出');
  r.truthy('退貨單總金額為負並標紅', (await rowOf(page, 'rtn-1').locator('td').nth(5).getAttribute('class')).includes('text-danger')
    && (await textOf(rowOf(page, 'rtn-1').locator('td').nth(5))).includes('-'));
  r.truthy('銷貨退回顯示未抵扣', (await textOf(rowOf(page, 'rtn-1').locator('td').nth(6))).includes('未抵扣'));
  const partial = await textOf(rowOf(page, 'rtn-2').locator('td').nth(6));
  r.truthy('進貨退出顯示部分抵扣與已抵金額', partial.includes('部分抵扣') && partial.includes('已抵') && partial.includes('50') && !partial.includes('-'));
  r.truthy('退貨單顯示已抵扣', (await textOf(rowOf(page, 'rtn-3').locator('td').nth(6))).includes('已抵扣'));
  r.truthy('原單標「已退 1 張」', (await textOf(rowOf(page, 'ord-s1'))).includes('已退 1 張'));
  r.truthy('退貨單標「退自 ORD-S1」', (await textOf(rowOf(page, 'rtn-1'))).includes('退自 ORD-S1'));
  r.check('類型篩選含兩種退貨',
    await page.locator('#search-type option').evaluateAll(os => os.map(o => o.value)),
    ['all', 'purchase', 'sale', 'adjust', 'sale_return', 'purchase_return']);

  await page.selectOption('#search-type', 'sale_return');
  await page.waitForTimeout(1200);
  r.truthy('篩銷貨退回會帶 type=eq.sale_return', state.searches.some(s => s.includes('type=eq.sale_return')));
  await page.selectOption('#search-type', 'all');
  await page.waitForTimeout(800);

  // 點「退自 ORD-S1」：關鍵字帶入原單號、類型放回全部（否則退貨單自己會被類型條件濾掉）
  await page.selectOption('#search-type', 'sale');
  await page.waitForTimeout(800);
  await rowOf(page, 'rtn-1').locator('.return-link').click();
  await page.waitForTimeout(1200);
  r.check('點退貨連結帶入原單號', await page.inputValue('#search-keyword'), 'ORD-S1');
  r.check('點退貨連結類型回到全部', await page.inputValue('#search-type'), 'all');
  r.truthy('查詢以原單號比對 search_text', state.searches.some(s => /search_text=ilike\.%25ORD-S1%25|search_text=ilike\.%ORD-S1%/.test(s)));
  await page.fill('#search-keyword', '');
  await page.fill('#search-date-from', '2000-01-01');
  await page.fill('#search-date-to', '2035-12-31');
  await page.selectOption('#search-status', 'all');
  await page.waitForTimeout(1200);

  // ===== 列印：只有出貨單與銷貨退回單可勾選，混選各用自己的格式 =====
  const pickable = async (id) => (await rowOf(page, id).locator('.print-pick').count()) > 0;
  r.check('出貨單可勾選列印', await pickable('ord-s1'), true);
  r.check('銷貨退回單可勾選列印', await pickable('rtn-1'), true);
  r.check('進貨退出不可勾選列印', await pickable('rtn-2'), false);
  r.check('進貨單不可勾選列印', await pickable('ord-p1'), false);

  await page.click('#btn-clear-selection').catch(() => {});
  await printSelected(page, ['ord-s1', 'rtn-1']);
  const slips = page.locator('#print-area .print-slip');
  r.check('混選印出兩張', await slips.count(), 2);
  r.truthy('混選：出貨單版面仍與黃金檔逐位元組相同',
    (await slips.nth(0).evaluate(e => e.outerHTML)) === golden);

  const ret = slips.nth(1);
  const retText = await textOf(ret);
  r.check('退貨單標題', await textOf(ret.locator('h2')), '銷貨退回單');
  r.truthy('退貨單日期欄為退貨日期', retText.includes('退貨日期：2026-11-01') && !retText.includes('出貨日期'));
  r.truthy('退貨單單號區含原出貨單號', retText.includes('單號：RTN-1') && retText.includes('原出貨單號：ORD-S1'));
  r.check('退貨單明細欄位', await ret.locator('thead th').allInnerTexts(), ['品名', '規格', '數量', '單位', '單價', '金額']);
  r.check('退貨單明細數量印正數', await ret.locator('tbody tr').evaluateAll(trs => trs.slice(0, 2).map(tr => tr.children[2].textContent.trim())), ['4', '1']);
  const totalRow = ret.locator('tbody tr').filter({ hasText: '退貨合計' });
  r.check('退貨合計印正數', await textOf(totalRow.locator('td').last()), '$760');
  r.check('退貨單沒有「明細合計」', await ret.locator('tbody tr').filter({ hasText: '明細合計' }).count(), 0);
  r.truthy('退貨單有應收餘額', (await textOf(ret.locator('tbody tr').filter({ hasText: '應收餘額' }))).includes('$5,000'));
  r.truthy('退貨單簽收欄', (await textOf(ret.locator('.print-footer'))).includes('客戶簽收（確認退回品項）'));

  // 展開後單張列印鈕：退貨單叫「列印退貨單」
  await rowOf(page, 'rtn-1').locator('td').nth(1).click();
  await page.waitForTimeout(1200);
  r.check('退貨單展開後的列印鈕', await textOf(page.locator('.detail-row .btn-print-shipping')), '列印退貨單');
  await rowOf(page, 'rtn-1').locator('td').nth(1).click();
  await page.waitForTimeout(400);

  // ===== 退貨 modal：可退數量、單價上限、折讓稅額預帶 =====
  await page.click('#btn-clear-selection').catch(() => {});
  await rowOf(page, 'ord-s1').locator('.btn-return').click();
  await page.waitForTimeout(1200);
  r.truthy('退貨 modal 開啟', await page.locator('#return-modal.active').count() > 0);
  r.check('退貨 modal 標題', await textOf(page.locator('#return-modal-title')), '銷貨退回 - ORD-S1');
  const cols = async (id) => lineRow(page, id).locator('td').evaluateAll(tds => tds.slice(1, 4).map(td => td.textContent.trim()));
  r.check('第一列 原數量／已退／可退', await cols('i-1'), ['10', '4', '6']);
  r.check('第二列 原數量／已退／可退', await cols('i-2'), ['5', '1', '4']);
  r.check('單價預設帶原價', await page.locator('#return-lines .rt-price').evaluateAll(es => es.map(e => e.value)), ['100', '400']);
  r.check('第二列顯示沿用的明細折扣', (await textOf(lineRow(page, 'i-2'))).includes('明細折扣 10%'), true);
  r.check('初始退貨合計為 0', await textOf(page.locator('#return-total')), '$0');

  // 退部分：3 支 × 100 = 300。折讓 100 × (300/2800)=10.71、稅 50 × (300/2800)=5.36
  await setLine(page, 'i-1', { qty: 3 });
  r.check('第一列小計', await textOf(lineRow(page, 'i-1').locator('.rt-subtotal')), '$300');
  r.check('整單折讓依比例預帶', await page.inputValue('#return-discount'), '10.71');
  r.check('稅額依比例預帶', await page.inputValue('#return-tax'), '5.36');
  // 300 − 10.71 + 5.36 = 294.65：金額顯示到分，不再取整成 $295
  r.check('退貨合計＝小計 − 折讓 + 稅', await textOf(page.locator('#return-total')), '$294.65');

  // 超過可退：離開欄位時夾回上限
  await setLine(page, 'i-1', { qty: 7 });
  r.check('數量超過可退夾回 6', await lineRow(page, 'i-1').locator('.rt-qty').inputValue(), '6');
  await setLine(page, 'i-1', { qty: 3 });
  // 單價超過原價：夾回原價
  await setLine(page, 'i-1', { price: 150 });
  r.check('單價超過原價夾回 100', await lineRow(page, 'i-1').locator('.rt-price').inputValue(), '100');
  // 小數數量不可被默默截掉：要改回整數讓使用者看見
  await setLine(page, 'i-1', { qty: 2.5 });
  r.check('小數數量改回整數', await lineRow(page, 'i-1').locator('.rt-qty').inputValue(), '2');
  // 清空單價不可變成 0 元退貨：改回原價
  await setLine(page, 'i-1', { qty: 3, price: '' });
  r.check('清空單價改回原價', await lineRow(page, 'i-1').locator('.rt-price').inputValue(), '100');
  // 單價可往下改，小計跟著變（含明細折扣的第二列：2 × 350 × 0.9 = 630）
  await setLine(page, 'i-2', { qty: 2, price: 350 });
  r.check('第二列小計含明細折扣', await textOf(lineRow(page, 'i-2').locator('.rt-subtotal')), '$630');
  // 手改折讓後不再被預帶蓋掉
  await page.fill('#return-discount', '0');
  await setLine(page, 'i-1', { qty: 4 });
  r.check('手改折讓後不被預帶蓋掉', await page.inputValue('#return-discount'), '0');
  // 折讓大於小計時合計為負，要真的顯示成紅字（以前被 inline style 的主色蓋掉）
  const totalColor = () => page.locator('#return-total').evaluate(e => getComputedStyle(e).color);
  r.check('合計為正時是主色', await totalColor(), 'rgb(192, 83, 31)');
  await page.fill('#return-discount', '99999');
  r.check('合計為負時是紅字', await totalColor(), 'rgb(197, 48, 48)');
  await page.fill('#return-discount', '0');

  // 退貨日期早於原單：不送出
  await page.fill('#return-date', '2026-10-01');
  await page.click('#btn-save-return');
  await page.waitForTimeout(600);
  r.check('退貨日早於原單不送出', state.createCalls.length, 0);
  r.truthy('退貨日早於原單有提示', (await textOf(page.locator('.toast-container'))).includes('退貨日期不可早於原單日期'));

  // ===== 送出 payload：全部退完剩餘可退數量，折讓／稅額帶原單剩餘額度（100−20、50−10） =====
  await page.fill('#return-date', '2026-11-13');
  await page.fill('#return-note', '換貨');
  await setLine(page, 'i-1', { qty: 6, price: 90 });
  await setLine(page, 'i-2', { qty: 4, price: 400 });
  await page.fill('#return-discount', '80');
  await page.fill('#return-tax', '40');
  r.check('最終退貨合計', await textOf(page.locator('#return-total')), '$1,940');
  await page.click('#btn-save-return');
  await page.waitForTimeout(1200);
  r.check('create_return_order 只送一次', state.createCalls.length, 1);
  r.check('create_return_order 的請求內容', state.createCalls[0], {
    p_original_order_id: 'ord-s1',
    p_items: [
      { item_id: 'i-1', qty: 6, unit_price: 90 },
      { item_id: 'i-2', qty: 4, unit_price: 400 }
    ],
    p_order_date: '2026-11-13',
    p_discount: 80,
    p_tax: 40,
    p_note: '換貨'
  });
  r.check('送出後 modal 關閉', await page.locator('#return-modal.active').count(), 0);

  // 全部退完時折讓／稅額預帶＝原單剩餘額度，不是比例（避免多次退貨的四捨五入湊不滿）
  await rowOf(page, 'ord-s1').locator('.btn-return').click();
  await page.waitForTimeout(1200);
  await setLine(page, 'i-1', { qty: 6 });
  await setLine(page, 'i-2', { qty: 4 });
  r.check('全部退完折讓預帶原單剩餘額度', await page.inputValue('#return-discount'), '80');
  r.check('全部退完稅額預帶原單剩餘額度', await page.inputValue('#return-tax'), '40');

  // 沒填數量不送出
  await setLine(page, 'i-1', { qty: 0 });
  await setLine(page, 'i-2', { qty: 0 });
  await page.click('#btn-save-return');
  await page.waitForTimeout(500);
  r.check('沒填數量不送出', state.createCalls.length, 1);

  // DB 退件時顯示對照後的中文訊息，modal 保持開著
  state.createError = 'RETURN_QTY_EXCEEDS: item abc';
  await setLine(page, 'i-1', { qty: 1 });
  await page.click('#btn-save-return');
  await page.waitForTimeout(800);
  r.check('超退錯誤碼對照成中文', (await textOf(page.locator('.toast-container'))).includes('退貨數量超過原單可退數量'), true);
  r.check('失敗時 modal 保持開啟', await page.locator('#return-modal.active').count(), 1);
  state.createError = null;
  await page.locator('#return-modal .close-btn').first().click();

  // 進貨單：標題、說明文字用進貨退出
  await rowOf(page, 'ord-p1').locator('.btn-return').click();
  await page.waitForTimeout(1200);
  r.check('進貨單退貨 modal 標題', await textOf(page.locator('#return-modal-title')), '進貨退出 - ORD-P1');
  await page.locator('#return-modal .close-btn').first().click();

  // ===== 合併顯示：分批單展開後，每一批各有退貨鈕，作廢的批次沒有 =====
  await goto(page, 'orders.html');
  await stubPrint(page);
  const groupRow = page.locator('tr.group-row').first();
  await groupRow.locator('td').nth(1).click();
  await page.waitForTimeout(1500);
  const batchHas = (id) => page.locator(`.batch-block[data-id="${id}"] .btn-return`).count().then(n => n > 0);
  r.check('第一批有退貨鈕', await batchHas('ord-b1'), true);
  r.check('接續批有退貨鈕', await batchHas('ord-b2'), true);
  r.check('作廢批沒有退貨鈕', await batchHas('ord-b3'), false);

  // ===== 對帳單：退貨列標籤與負數 =====
  await goto(page, 'statement.html');
  await page.click('#btn-search');
  await page.waitForTimeout(2500);
  const stmtRows = page.locator('.statement-section.is-active .statement-table tbody tr');
  r.check('對帳單兩列明細', await stmtRows.count(), 2);
  r.check('出貨列沒有退貨標籤', await stmtRows.nth(0).locator('.return-tag').count(), 0);
  r.check('退貨列有退貨標籤', await textOf(stmtRows.nth(1).locator('.return-tag')), '退貨');
  const stmtCells = await stmtRows.nth(1).locator('td').allInnerTexts();
  r.check('退貨列數量為負', stmtCells[4].trim(), '-3');
  r.check('退貨列單價維持正數', stmtCells[6].trim(), '$100');
  r.check('退貨列金額為負', stmtCells[7].trim().replace('-NT', '-').replace('NT', ''), '-$300');

  // ===== 商品進出明細：兩種退貨徽章、方向與金額 =====
  await goto(page, 'products.html');
  await page.locator('#products-table tbody tr.clickable-row').first().locator('td').nth(1).click();
  await page.waitForTimeout(2000);
  const mv = page.locator('#cost-modal .records-table tbody tr');
  r.check('進出明細三列', await mv.count(), 3);
  r.check('銷貨退回徽章', await textOf(mv.nth(1).locator('.badge-red')), '銷貨退回');
  r.check('進貨退出徽章', await textOf(mv.nth(2).locator('.badge-orange-red')), '進貨退出');
  const mvCells = async (i) => (await mv.nth(i).locator('td').allInnerTexts()).map(t => t.trim());
  const saleReturn = await mvCells(1);
  r.check('銷貨退回數量為 +（貨回來）', saleReturn[3], '+3');
  r.check('銷貨退回單價為正', saleReturn[4].replace('NT', ''), '$100');
  r.check('銷貨退回金額為負', saleReturn[5].replace('NT', ''), '-$300');
  const purchaseReturn = await mvCells(2);
  r.check('進貨退出數量為 −（貨出去）', purchaseReturn[3], '-2');
  r.check('進貨退出金額為負', purchaseReturn[5].replace('NT', ''), '-$200');

  // 「超退錯誤碼」那段是刻意讓假 RPC 回 400，對應的 console 錯誤是預期內的，其餘錯誤才算失敗
  const unexpected = errors.filter(e => !e.includes('status of 400') && !e.includes('Error creating return order'));
  r.check('只有預期內的 console 錯誤（刻意的 400）', errors.length - unexpected.length, 2);
  r.finish(unexpected, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
