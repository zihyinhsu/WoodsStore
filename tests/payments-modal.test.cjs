const { launch, goto, Results } = require('./helpers');

// 收款 Modal：金額由勾選的出貨單加總推導，使用者不再自行輸入或分配。
// 走預設的寫入攔截（allowWrites: false），全程只讀不寫。

// 顯示金額經 formatCurrency 取整，精確值看 hidden input，顯示值只比對到整數。
const hiddenAmount = page => page.inputValue('#payment-amount').then(Number);
const shownAmount = page =>
  page.textContent('#payment-amount-display').then(t => Number(t.replace(/[^0-9.-]/g, '')));
const rowAmount = (page, i) =>
  page.locator('.allocation-row').nth(i).getAttribute('data-amount').then(Number);

// 原生 checkbox 被 .checkbox 樣式視覺隱藏（實際看到的是 .checkbox-box），
// Playwright 的 check() 會因不可見而逾時，要點使用者真正點的 label。
async function toggleRow(page, i) {
  await page.locator('.allocation-row').nth(i).locator('label.checkbox').click();
  await page.waitForTimeout(300);
}

// 未收單分散在各客戶身上，逐一試到出現可勾選的出貨單為止。
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
  const r = new Results('收款 Modal');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'payments.html');

  // 舊版的手動分配元件必須整組消失，殘留任何一個都代表改動沒做完
  r.check('已移除自動分配按鈕', await page.locator('#btn-auto-allocate').count(), 0);
  r.check('已移除已分配總額', await page.locator('#allocated-total').count(), 0);
  r.check('已移除未分配提示', await page.locator('#unallocated-hint').count(), 0);
  r.check('已移除逐單金額輸入', await page.locator('.allocation-amount').count(), 0);

  await page.click('#btn-add-payment');
  await page.waitForTimeout(800);

  r.check('金額欄不可輸入', await page.getAttribute('#payment-amount', 'type'), 'hidden');
  r.check('初始金額為 0', await shownAmount(page), 0);

  const partner = await pickPartnerWithOrders(page);
  if (!partner) {
    r.info('略過勾選驗證', '所有客戶都沒有未收款的出貨單');
  } else {
    const count = await page.locator('.allocation-row').count();
    r.info('可勾選出貨單數', count);

    // 明細不再是按鈕展開，載入時就一次撈齊直接顯示
    r.check('沒有明細展開按鈕', await page.locator('.btn-toggle-items').count(), 0);
    r.truthy('明細預設顯示', await page.locator('.allocation-row .allocation-items').first().isVisible());

    // 新增收款時全部未勾，因此以下每次點擊都是明確的「勾起來／取消」
    const first = await rowAmount(page, 0);

    await toggleRow(page, 0);
    r.check('勾一張帶入該單全額', await hiddenAmount(page), first);
    r.check('顯示金額同步', await shownAmount(page), Math.round(first));

    if (count > 1) {
      const second = await rowAmount(page, 1);
      await toggleRow(page, 1);
      r.check('勾兩張為加總', await hiddenAmount(page), first + second);

      await toggleRow(page, 0);
      r.check('取消一張後扣回', await hiddenAmount(page), second);
      await toggleRow(page, 1);
    } else {
      await toggleRow(page, 0);
    }

    r.check('全部取消歸零', await hiddenAmount(page), 0);

    // 沒勾任何單就送出應被前端擋下，不可送到後端才被 amount <= 0 擋
    const before = blockedWrites.length;
    await page.click('#btn-save-payment');
    await page.waitForTimeout(1500);
    r.truthy('未勾選時擋下送出', blockedWrites.length === before);
    r.truthy('未勾選時顯示提示', await page.locator('.toast').count() > 0);
    r.truthy('未勾選時不關閉視窗', await page.locator('#payment-modal.active').count() > 0);
  }

  await page.locator('#payment-modal .close-btn').first().click();
  await page.waitForTimeout(400);

  // 舊版手動沖帳留下的收款（部分沖帳或有未分配預收）必須整區唯讀，
  // 否則用新規則重存會靜默改掉金額。正式庫不保證有這種資料，沒有就略過。
  const legacyRow = page.locator('#payments-table tbody tr', { hasText: '未分配' }).first();
  if (await legacyRow.count() > 0) {
    await legacyRow.locator('.btn-edit-payment').click();
    await page.waitForTimeout(2000);
    r.truthy('舊制收款顯示唯讀提示', await page.locator('#payment-legacy-hint').isVisible());
    r.truthy('舊制收款鎖定客戶', await page.isDisabled('#payment-partner'));
    r.truthy('舊制收款鎖定勾選', await page.locator('.order-checkbox:disabled').count() > 0);
  } else {
    r.info('略過舊制唯讀驗證', '目前沒有含未分配金額的收款');
  }

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
