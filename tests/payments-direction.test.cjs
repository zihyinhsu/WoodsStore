const { launch, goto, Results } = require('./helpers');

// 收付款方向：付款給供應商沿用收款的同一套表與沖帳機制（patch-027），
// 方向由往來對象決定（客戶＝收款沖出貨單、供應商＝付款沖進貨單）。
// 走預設的寫入攔截（allowWrites: false），全程只讀不寫。

const hiddenAmount = page => page.inputValue('#payment-amount').then(Number);
const rowAmount = (page, i) =>
  page.locator('.allocation-row').nth(i).getAttribute('data-amount').then(Number);

// 原生 checkbox 被 .checkbox 樣式視覺隱藏，要點使用者真正點的 label（同收款 Modal 測試）。
async function toggleRow(page, i) {
  await page.locator('.allocation-row').nth(i).locator('label.checkbox').click();
  await page.waitForTimeout(300);
}

// 未付進貨單分散在各供應商身上，逐一試到出現可勾選的單為止。
async function pickPartnerWithOrders(page, max = 12) {
  const values = await page.$$eval('#payment-partner option', opts =>
    opts.map(o => o.value).filter(Boolean));

  for (const value of values.slice(0, max)) {
    await page.selectOption('#payment-partner', value);
    await page.waitForTimeout(1500);
    if (await page.locator('.allocation-row').count() > 0) return value;
  }
  return null;
}

(async () => {
  const r = new Results('收付款方向');
  const { browser, page, errors, blockedWrites } = await launch();

  // 改名後的選單：側欄文字是使用者找功能的唯一入口
  await goto(page, 'payments.html');
  r.check('側欄有收付款管理', await page.locator('.nav-item[data-page="payments.html"] .nav-label').innerText(), '收付款管理');
  r.check('側欄有進出貨管理', await page.locator('.nav-item[data-page="orders.html"] .nav-label').innerText(), '進出貨管理');

  // 預設是收款分頁，既有收款流程不受影響
  r.check('預設為收款分頁', await page.getAttribute('.tab-btn[data-dir="in"]', 'aria-selected'), 'true');
  r.check('收款分頁按鈕文字', await page.innerText('#btn-add-payment'), '新增收款');

  // 收款與付款的往來對象不能混在一起：各自的下拉選單只該出現該類型
  const customerOptions = await page.$$eval('#search-partner option', opts =>
    opts.map(o => o.value).filter(v => v !== 'all'));

  await page.click('.tab-btn[data-dir="out"]');
  await page.waitForTimeout(3000);

  r.check('切到付款分頁', await page.getAttribute('.tab-btn[data-dir="out"]', 'aria-selected'), 'true');
  r.check('付款分頁按鈕文字', await page.innerText('#btn-add-payment'), '新增付款');
  r.check('網址記住付款分頁', new URL(page.url()).searchParams.get('dir'), 'out');

  const supplierOptions = await page.$$eval('#search-partner option', opts =>
    opts.map(o => o.value).filter(v => v !== 'all'));
  r.info('供應商數', supplierOptions.length);
  r.truthy('付款對象不含客戶', supplierOptions.every(id => !customerOptions.includes(id)));

  // 付款先不做列印：列上沒有列印按鈕，也沒有可勾選列印的格子
  r.check('付款列沒有列印按鈕', await page.locator('#payments-table .btn-print').count(), 0);
  r.check('付款列沒有列印勾選', await page.locator('#payments-table .print-pick').count(), 0);

  await page.click('#btn-add-payment');
  await page.waitForTimeout(800);
  r.check('Modal 標題為新增付款', await page.innerText('#payment-modal-title'), '新增付款');

  const partner = await pickPartnerWithOrders(page);
  if (!partner) {
    r.info('略過勾選驗證', '所有供應商都沒有未付款的進貨單');
  } else {
    r.truthy('選的是供應商', supplierOptions.includes(partner));

    const first = await rowAmount(page, 0);
    await toggleRow(page, 0);
    r.check('勾一張進貨單帶入該單全額', await hiddenAmount(page), first);
    await toggleRow(page, 0);
    r.check('取消後歸零', await hiddenAmount(page), 0);
  }

  await page.locator('#payment-modal .close-btn').first().click();
  await page.waitForTimeout(400);

  // 進貨單在進出貨管理也要看得到付款狀態，且點下去會帶到付款分頁
  await goto(page, 'orders.html?type=purchase&status=confirmed');
  const purchaseRows = page.locator('#orders-table tbody tr.clickable-row');
  const rowCount = await purchaseRows.count();
  if (rowCount === 0) {
    r.info('略過進貨單付款狀態驗證', '查詢區間內沒有已確認的進貨單');
  } else {
    r.check('已確認進貨單皆有付款狀態連結',
      await page.locator('#orders-table tbody tr.clickable-row .payment-link').count(), rowCount);

    await page.locator('#orders-table tbody tr.clickable-row .payment-link').first().click();
    await page.waitForTimeout(3500);
    r.check('從進貨單跳轉後為付款分頁',
      await page.getAttribute('.tab-btn[data-dir="out"]', 'aria-selected'), 'true');
  }

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
