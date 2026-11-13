const { launch, goto, Results } = require('./helpers');

// 收款頁的退貨抵扣：淨額計算、部分抵扣、0 元沖帳單、編輯含部分抵扣退貨的既有收款。
//
// 退貨 schema 尚未套用到連線的資料庫（見 docs/returns-plan.md），而且測試連的是實際資料庫，
// 所以未收單、既有收款、對帳明細全部用 page.route 假資料餵進去，不依賴資料庫內容。
// save_payment_with_allocations 也由本測試攔截並記錄 request body——
// 寫入從頭到尾不會真的送出（不傳 allowWrites）。

const PARTNER = { id: 'cust-1', partner_no: 'C001', name: '測試客戶', type: 'customer' };

const summaryRow = (order_id, order_no, order_date, order_total, outstanding_amount) =>
  ({ order_id, order_no, order_date, order_total, outstanding_amount, partner_id: PARTNER.id });

const S1 = ['S1', 'ORD-S1', '2026-11-01', 150, 150];
const S2 = ['S2', 'ORD-S2', '2026-11-02', 500, 500];
const R1 = ['R1', 'RTN-R1', '2026-11-03', -300, -300];
const R2 = ['R2', 'RTN-R2', '2026-11-04', -400, -400];

const payments = [
  // 0 元沖帳單：S1 +150 與 R1 −150（R1 原額 −300，只抵了一半）
  { id: 'pay-1', payment_no: 'RC-0001', partner_id: PARTNER.id, partner_name: PARTNER.name, partner_type: 'customer',
    payment_date: '2026-11-10', amount: 0, method: 'cash', note: null, unallocated_amount: 0,
    order_count: 2, top_order_no: 'ORD-S1', order_ids: ['S1', 'R1'] },
  // 舊制部分沖帳：出貨單 S2 500 只沖了 200，必須仍被鎖成唯讀
  { id: 'pay-2', payment_no: 'RC-0002', partner_id: PARTNER.id, partner_name: PARTNER.name, partner_type: 'customer',
    payment_date: '2026-11-11', amount: 200, method: 'cash', note: null, unallocated_amount: 0,
    order_count: 1, top_order_no: 'ORD-S2', order_ids: ['S2'] }
];

const allocationsByPayment = {
  'pay-1': [
    { payment_id: 'pay-1', order_id: 'S1', order_no: 'ORD-S1', order_date: '2026-11-01', order_total: 150, allocated_amount: 150 },
    { payment_id: 'pay-1', order_id: 'R1', order_no: 'RTN-R1', order_date: '2026-11-03', order_total: -300, allocated_amount: -150 }
  ],
  'pay-2': [
    { payment_id: 'pay-2', order_id: 'S2', order_no: 'ORD-S2', order_date: '2026-11-02', order_total: 500, allocated_amount: 200 }
  ]
};

const statementLines = [
  { order_id: 'S1', type: 'sale', order_no: 'ORD-S1', order_date: '2026-11-01', product_name: '矽利康', spec: '', qty: 3, unit: '支', unit_price: 50, subtotal: 150 },
  { order_id: 'R1', type: 'sale_return', order_no: 'RTN-R1', order_date: '2026-11-03', product_name: '矽利康', spec: '', qty: -2, unit: '支', unit_price: 150, subtotal: -300 }
];

// 依 Accept 回應：supabase-js 的 .single() 要的是單一物件而不是陣列。
function respond(route, rows) {
  const wantsObject = (route.request().headers().accept || '').includes('vnd.pgrst.object');
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
    body: JSON.stringify(wantsObject ? rows[0] ?? null : rows)
  });
}

// 只接管 GET；其餘（含寫入）交回 launch() 預設的攔截處理。
function mockTable(page, name, getRows) {
  return page.route(new RegExp(`/rest/v1/${name}(\\?|$)`), route => {
    if (route.request().method() !== 'GET') return route.fallback();
    respond(route, getRows(route.request().url()));
  });
}

const hiddenAmount = page => page.inputValue('#payment-amount').then(Number);
const row = (page, id) => page.locator(`.allocation-row[data-id="${id}"]`);
const rowAmount = (page, id) => row(page, id).getAttribute('data-amount').then(Number);
const rowFull = (page, id) => row(page, id).getAttribute('data-full').then(Number);
const rowChecked = (page, id) => row(page, id).locator('.order-checkbox').isChecked();
const rowNote = async (page, id) => {
  const note = row(page, id).locator('.allocation-offset-note');
  return (await note.isVisible()) ? (await note.textContent()).trim() : '';
};

// 原生 checkbox 被樣式視覺隱藏，要點使用者真正點的 label（同其他收款測試）。
async function toggle(page, id) {
  await row(page, id).locator('label.checkbox').click();
  await page.waitForTimeout(150);
}
async function checkInOrder(page, ...ids) {
  for (const id of ids) await toggle(page, id);
}

async function openNewPayment(page) {
  await page.click('#btn-add-payment');
  await page.waitForTimeout(300);
  await page.selectOption('#payment-partner', PARTNER.id);
  await page.waitForSelector('.allocation-row');
}

async function openEdit(page, paymentId) {
  await page.locator(`.btn-edit-payment[data-id="${paymentId}"]`).click();
  await page.waitForSelector('.allocation-row');
  await page.waitForTimeout(300);
}

async function closeModal(page) {
  await page.locator('#payment-modal .close-btn').first().click();
  await page.waitForTimeout(300);
}

(async () => {
  const r = new Results('收款頁：退貨抵扣');
  const { browser, page, errors, blockedWrites } = await launch();

  // 每個情境各自指定「未收單」：同一組假資料在新增與編輯時，
  // 後端回的未收金額本來就不同（編輯時這筆收款已經沖過一部分）。
  let outstanding = [S1, S2, R1, R2];
  const summaryUrls = [];
  const saved = [];

  await mockTable(page, 'partners', () => [PARTNER]);
  await mockTable(page, 'payment_search_view', () => payments);
  await mockTable(page, 'partner_balance_view', () => [{ id: PARTNER.id, balance: 0 }]);
  await mockTable(page, 'order_items', () => []);
  await mockTable(page, 'order_search_view', () => []);
  await mockTable(page, 'payment_orders', () => [{ order_id: 'S1' }, { order_id: 'R1' }]);
  await mockTable(page, 'statement_line_view', () => statementLines);
  await mockTable(page, 'order_payment_summary_view', url => {
    summaryUrls.push(url);
    return outstanding.map(o => summaryRow(...o));
  });
  await mockTable(page, 'payment_allocation_view', url => {
    const id = new URL(url).searchParams.get('payment_id')?.replace('eq.', '');
    return allocationsByPayment[id] || [];
  });
  await page.route('**/rest/v1/rpc/get_partner_balances', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]'
  }));
  await page.route('**/rest/v1/rpc/save_payment_with_allocations', route => {
    saved.push(route.request().postDataJSON());
    route.fulfill({ status: 200, contentType: 'application/json', body: '"pay-new"' });
  });

  // headless 的 window.print() 是空操作，但列印區的內容仍會寫入 #print-area，供下面檢查收據。
  await page.addInitScript(() => { window.print = () => {}; });

  await goto(page, 'payments.html');

  // ---- 未收單查詢：退貨單的未抵扣金額是負數 ----
  await openNewPayment(page);
  const summaryUrl = decodeURIComponent(summaryUrls.at(-1) || '');
  r.truthy('未收單改用 outstanding_amount <> 0 查詢', summaryUrl.includes('outstanding_amount=neq.0'));
  r.truthy('未收單查詢不再是 > 0', !summaryUrl.includes('outstanding_amount=gt.0'));

  r.check('出貨與退貨共 4 列', await page.locator('.allocation-row').count(), 4);
  r.check('退貨列標為 return', await page.locator('.allocation-row[data-kind="return"]').count(), 2);
  r.truthy('退貨列有銷貨退回標籤', (await row(page, 'R1').textContent()).includes('銷貨退回'));
  r.check('退貨列金額為負', await rowAmount(page, 'R1'), -300);
  r.truthy('退貨金額紅字', await row(page, 'R1').locator('.allocation-amount.text-danger').count() > 0);
  r.check('出貨列金額為正', await rowAmount(page, 'S1'), 150);

  // ---- 淨額計算：出貨 500 + 退貨 −300 = 200，退貨整張抵扣、不收 0 元 ----
  await checkInOrder(page, 'S2', 'R1');
  r.check('淨額 = 500 − 300', await hiddenAmount(page), 200);
  r.check('退貨整張抵扣', await rowAmount(page, 'R1'), -300);
  r.check('整張抵扣時不顯示待抵', await rowNote(page, 'R1'), '');
  r.truthy('有現金時仍顯示收款方式', await page.locator('#payment-method-group').isVisible());

  // 單一常駐 handler：once 型的 handler 若沒被觸發會殘留，吃掉後面情境的對話框。
  const dialogLog = [];
  let nextDialog = 'dismiss';
  page.on('dialog', d => {
    dialogLog.push(d.message());
    return nextDialog === 'accept' ? d.accept() : d.dismiss();
  });

  await page.click('#btn-save-payment');
  await page.waitForTimeout(600);
  r.check('淨額 > 0 不跳確認', dialogLog.length, 0);
  r.check('淨額 > 0 送出一次', saved.length, 1);
  r.check('淨額 > 0 的 payload', {
    amount: saved[0]?.p_amount,
    allocations: saved[0]?.p_allocations,
    id: saved[0]?.p_payment_id
  }, {
    amount: 200,
    allocations: [{ order_id: 'S2', amount: 500 }, { order_id: 'R1', amount: -300 }],
    id: null
  });
  r.truthy('儲存成功後關閉視窗', await page.locator('#payment-modal.active').count() === 0);

  // ---- 部分抵扣：出貨 +150、退貨 −300 → 退貨自動調為 −150，存成 0 元沖帳單 ----
  await openNewPayment(page);
  await checkInOrder(page, 'S1', 'R1');
  r.check('退貨自動調為 −150', await rowAmount(page, 'R1'), -150);
  r.check('可動用額度仍是 −300', await rowFull(page, 'R1'), -300);
  r.check('淨額為 0', await hiddenAmount(page), 0);
  r.check('顯示「剩 −150 待抵」', await rowNote(page, 'R1'), '本次抵 -150，剩 -150 待抵');
  r.truthy('0 元沖帳單隱藏收款方式', !(await page.locator('#payment-method-group').isVisible()));
  r.truthy('顯示不收現金提示', await page.locator('#payment-offset-hint').isVisible());

  // 先取消確認：不能送出，視窗也要留著讓使用者調整
  saved.length = 0;
  nextDialog = 'dismiss';
  await page.click('#btn-save-payment');
  await page.waitForTimeout(600);
  r.truthy('送出前確認不收現金', (dialogLog.at(-1) || '').includes('本次不收現金，僅以退貨抵扣'));
  r.check('取消確認就不送出', saved.length, 0);
  r.truthy('取消確認後視窗保留', await page.locator('#payment-modal.active').count() > 0);

  nextDialog = 'accept';
  await page.click('#btn-save-payment');
  await page.waitForTimeout(600);
  r.check('確認後送出 0 元沖帳單', saved.length, 1);
  r.check('0 元沖帳單的 payload', {
    amount: saved[0]?.p_amount,
    allocations: saved[0]?.p_allocations
  }, {
    amount: 0,
    allocations: [{ order_id: 'S1', amount: 150 }, { order_id: 'R1', amount: -150 }]
  });
  r.truthy('p_method 仍帶值（schema 必填）', Boolean(saved[0]?.p_method));

  // ---- 重算：多勾出貨後恢復、取消出貨後再調低、只剩退貨時抵 0 ----
  await openNewPayment(page);
  await checkInOrder(page, 'S1', 'R1');
  r.check('起點：R1 調為 −150', await rowAmount(page, 'R1'), -150);

  await toggle(page, 'S2');
  r.check('再勾出貨 500 後退貨恢復整張', await rowAmount(page, 'R1'), -300);
  r.check('恢復後淨額 = 150 + 500 − 300', await hiddenAmount(page), 350);
  r.check('恢復後不再顯示待抵', await rowNote(page, 'R1'), '');
  r.truthy('淨額 > 0 時收款方式回來', await page.locator('#payment-method-group').isVisible());

  await toggle(page, 'S2');
  r.check('取消出貨後退貨再度調低', await rowAmount(page, 'R1'), -150);
  r.check('取消出貨後淨額為 0', await hiddenAmount(page), 0);

  await toggle(page, 'S1');
  r.check('只剩退貨時抵扣為 0', await rowAmount(page, 'R1'), 0);
  r.check('只剩退貨時金額為 0', await hiddenAmount(page), 0);
  r.truthy('只剩退貨時不當成沖帳單', await page.locator('#payment-method-group').isVisible());
  r.check('只剩退貨時待抵為全額', await rowNote(page, 'R1'), '本次抵 0，剩 -300 待抵');

  saved.length = 0;
  await page.click('#btn-save-payment');
  await page.waitForTimeout(400);
  r.check('沒有任何有效分配就不送出', saved.length, 0);
  await closeModal(page);

  // ---- 兩張退貨：從「最後勾選」的那張往回調，不是從畫面最下面那張 ----
  // 出貨 500，退貨 R1 −300、R2 −400：合計退貨 700，多出 200。
  await openNewPayment(page);
  await checkInOrder(page, 'S2', 'R2', 'R1');
  r.check('先勾 R2 再勾 R1：調 R1（最後勾）', await rowAmount(page, 'R1'), -100);
  r.check('先勾 R2 再勾 R1：R2 維持整張', await rowAmount(page, 'R2'), -400);
  r.check('兩張退貨淨額為 0', await hiddenAmount(page), 0);
  await closeModal(page);

  await openNewPayment(page);
  await checkInOrder(page, 'S2', 'R1', 'R2');
  r.check('先勾 R1 再勾 R2：調 R2（最後勾）', await rowAmount(page, 'R2'), -200);
  r.check('先勾 R1 再勾 R2：R1 維持整張', await rowAmount(page, 'R1'), -300);
  r.check('R2 顯示待抵 −200', await rowNote(page, 'R2'), '本次抵 -200，剩 -200 待抵');

  await toggle(page, 'R1');
  r.check('取消 R1 後 R2 恢復整張', await rowAmount(page, 'R2'), -400);
  r.check('取消 R1 後淨額 = 500 − 400', await hiddenAmount(page), 100);

  // 取消再重勾 R1：R1 變成「最後勾」，被調低的換成它
  await toggle(page, 'R1');
  r.check('重勾 R1 後調整對象換成 R1', await rowAmount(page, 'R1'), -100);
  r.check('重勾 R1 後 R2 維持整張', await rowAmount(page, 'R2'), -400);
  await closeModal(page);

  // ---- 編輯含部分抵扣退貨的既有收款（pay-1：S1 +150、R1 −150，R1 原額 −300）----
  // 這筆收款存在時，後端回的未抵扣：S1 已沖完（不在清單）、R1 剩 −150、另有 S2 與 R2。
  outstanding = [S2, ['R1', 'RTN-R1', '2026-11-03', -300, -150], R2];
  await openEdit(page, 'pay-1');

  r.truthy('含部分抵扣的收款沒被誤判為舊制', !(await page.locator('#payment-legacy-hint').isVisible()));
  r.truthy('客戶欄未鎖定', !(await page.isDisabled('#payment-partner')));
  r.check('沒有被鎖住的勾選框', await page.locator('.order-checkbox:disabled').count(), 0);
  r.truthy('出貨列已勾選', await rowChecked(page, 'S1'));
  r.truthy('退貨列已勾選', await rowChecked(page, 'R1'));
  r.truthy('未沖的其他單不勾選', !(await rowChecked(page, 'S2')));
  r.check('退貨列帶回當時的分配 −150', await rowAmount(page, 'R1'), -150);
  r.check('可動用上限 = 剩餘 −150 + 原分配 −150', await rowFull(page, 'R1'), -300);
  r.check('編輯時顯示待抵', await rowNote(page, 'R1'), '本次抵 -150，剩 -150 待抵');
  r.check('編輯時金額仍為 0', await hiddenAmount(page), 0);
  r.truthy('編輯 0 元沖帳單隱藏收款方式', !(await page.locator('#payment-method-group').isVisible()));

  await toggle(page, 'S2');
  r.check('編輯時多勾出貨，退貨用到上限', await rowAmount(page, 'R1'), -300);
  r.check('編輯時淨額 = 150 + 500 − 300', await hiddenAmount(page), 350);

  saved.length = 0;
  await page.click('#btn-save-payment');
  await page.waitForTimeout(600);
  r.check('編輯送出一次', saved.length, 1);
  r.check('編輯的 payload', {
    id: saved[0]?.p_payment_id,
    amount: saved[0]?.p_amount,
    allocations: saved[0]?.p_allocations
  }, {
    id: 'pay-1',
    amount: 350,
    allocations: [
      { order_id: 'S1', amount: 150 },
      { order_id: 'S2', amount: 500 },
      { order_id: 'R1', amount: -300 }
    ]
  });

  // 沒動任何勾選就存：退貨維持當時存下的 −150，不被重新計算改掉
  outstanding = [S2, ['R1', 'RTN-R1', '2026-11-03', -300, -150], R2];
  await openEdit(page, 'pay-1');
  saved.length = 0;
  nextDialog = 'accept';
  await page.click('#btn-save-payment');
  await page.waitForTimeout(600);
  r.check('未改動就存：分配維持原樣', saved[0]?.p_allocations,
    [{ order_id: 'S1', amount: 150 }, { order_id: 'R1', amount: -150 }]);
  r.check('未改動就存：金額 0', saved[0]?.p_amount, 0);

  // ---- 舊制部分沖帳的「出貨單」仍要鎖成唯讀（排除退貨不能連出貨一起放過）----
  outstanding = [['S2', 'ORD-S2', '2026-11-02', 500, 300]];
  await openEdit(page, 'pay-2');
  r.truthy('舊制部分沖帳仍顯示唯讀提示', await page.locator('#payment-legacy-hint').isVisible());
  r.truthy('舊制部分沖帳仍鎖定客戶', await page.isDisabled('#payment-partner'));
  r.truthy('舊制部分沖帳仍鎖定勾選', await page.locator('.order-checkbox:disabled').count() > 0);
  await closeModal(page);

  // ---- 列表與收據 ----
  const pay1Row = page.locator('#payments-table tbody tr[data-id="pay-1"]');
  r.truthy('0 元沖帳單的方式欄顯示「沖帳」', (await pay1Row.locator('td').nth(6).textContent()).includes('沖帳'));

  await page.locator('.btn-print[data-id="pay-1"]').click();
  await page.waitForTimeout(800);
  const slip = await page.locator('#print-area').innerHTML();
  r.truthy('0 元收據標題為沖帳單', slip.includes('<h2>沖帳單</h2>'));
  r.truthy('收據標出退貨列', slip.includes('【退貨】'));
  r.truthy('收據退貨列為負數', slip.includes('-300'));

  await page.locator('.btn-print[data-id="pay-2"]').click();
  await page.waitForTimeout(800);
  r.truthy('有金額的收據標題仍為收款單', (await page.locator('#print-area').innerHTML()).includes('<h2>收款單</h2>'));

  r.check('寫入全程被攔截或由本測試接管（沒有漏網的真實寫入）',
    blockedWrites.filter(w => !/save_payment_with_allocations/.test(w)), []);

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
