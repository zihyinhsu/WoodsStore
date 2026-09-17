const { launch, goto, Results } = require('./helpers');

const fieldState = async page => ({
  title: (await page.textContent('#order-modal-title')).trim(),
  typeDisabled: await page.isDisabled('#order-type'),
  dateDisabled: await page.isDisabled('#order-date'),
  partnerDisabled: await page.isDisabled('#order-partner'),
  discountDisabled: await page.isDisabled('#order-discount'),
  taxDisabled: await page.isDisabled('#order-tax'),
  noteDisabled: await page.isDisabled('#order-note'),
  hintVisible: await page.locator('#confirmed-edit-hint').isVisible(),
  addLineVisible: await page.locator('#btn-add-line').isVisible()
});

(async () => {
  const r = new Results('單據編輯');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'orders.html');
  await page.selectOption('#search-status', 'all');
  await page.fill('#search-date-from', '2000-01-01');
  await page.fill('#search-date-to', '2035-12-31');
  await page.waitForTimeout(3500);

  // 連點列不應重複展開明細
  const cell = page.locator('tr.clickable-row').first().locator('td').nth(1);
  await cell.click();
  await cell.click();
  await page.waitForTimeout(2500);
  const afterDouble = await page.locator('.detail-row').count();
  r.truthy('連點兩次不重複展開', afterDouble <= 1);

  await cell.click(); await cell.click(); await cell.click();
  await page.waitForTimeout(2500);
  r.truthy('連點三次不重複展開', (await page.locator('.detail-row').count()) <= 1);

  await page.evaluate(() => {
    document.querySelectorAll('.detail-row').forEach(e => e.remove());
    document.querySelectorAll('.detail-open').forEach(e => e.classList.remove('detail-open'));
  });
  await cell.click();
  await page.waitForTimeout(2000);
  r.check('單擊展開一列明細', await page.locator('.detail-row').count(), 1);
  await cell.click();
  await page.waitForTimeout(600);
  r.check('再次點擊收合', await page.locator('.detail-row').count(), 0);

  // 按鈕依狀態顯示
  // 讀 badge 的 data-status 而非欄位索引：類型與狀態同格後，位置已不對應欄名
  const byStatus = await page.locator('tr.clickable-row').evaluateAll(trs => {
    const out = {};
    trs.forEach(tr => {
      const s = tr.querySelector('[data-status]')?.dataset.status;
      out[s] = out[s] || { total: 0, edit: 0 };
      out[s].total++;
      if (tr.querySelector('.btn-edit')) out[s].edit++;
    });
    return out;
  });
  r.info('各狀態單據數', JSON.stringify(byStatus));
  if (byStatus['void']) {
    r.check('作廢單無編輯按鈕', byStatus['void'].edit, 0);
  }
  if (byStatus['confirmed']) {
    r.check('已確認單有編輯按鈕', byStatus['confirmed'].edit, byStatus['confirmed'].total);
  }

  // 新增模式：所有欄位可編輯
  await page.click('#btn-add-order');
  await page.waitForTimeout(600);
  const create = await fieldState(page);
  r.check('新增模式標題', create.title, '新增單據');
  r.check('新增模式可選類型', create.typeDisabled, false);
  r.check('新增模式無唯讀提示', create.hintVisible, false);
  await page.locator('#order-modal .close-btn').first().click();
  await page.waitForTimeout(500);

  // 草稿：表頭與明細可編輯，僅類型鎖定
  const draftRow = page.locator('tr.clickable-row').filter({ hasText: '草稿' }).first();
  if (await draftRow.count() > 0) {
    await draftRow.locator('.btn-edit').click();
    await page.waitForTimeout(2000);
    const draft = await fieldState(page);
    r.check('草稿模式標題', draft.title, '編輯草稿');
    r.check('草稿鎖定單據類型', draft.typeDisabled, true);
    r.check('草稿可改日期', draft.dateDisabled, false);
    r.check('草稿可加明細', draft.addLineVisible, true);
    const disabledLines = await page.locator('#order-lines input, #order-lines select')
      .evaluateAll(els => els.filter(e => e.disabled).length);
    r.check('草稿明細可編輯', disabledLines, 0);
    await page.locator('#order-modal .close-btn').first().click();
    await page.waitForTimeout(500);
  } else {
    r.info('草稿測試', '無草稿單據，略過');
  }

  // 已確認：僅備註可編輯
  const confirmedRow = page.locator('tr.clickable-row').filter({ hasText: '已確認' }).first();
  if (await confirmedRow.count() > 0) {
    await confirmedRow.locator('.btn-edit').click();
    await page.waitForTimeout(2000);
    const c = await fieldState(page);
    r.check('已確認模式標題', c.title, '編輯單據');
    r.check('已確認鎖定日期', c.dateDisabled, true);
    r.check('已確認鎖定往來對象', c.partnerDisabled, true);
    r.check('已確認鎖定折讓', c.discountDisabled, true);
    r.check('已確認鎖定稅額', c.taxDisabled, true);
    r.check('已確認可改備註', c.noteDisabled, false);
    r.check('已確認顯示唯讀提示', c.hintVisible, true);
    r.check('已確認隱藏加入商品', c.addLineVisible, false);

    const total = await page.locator('#order-lines input, #order-lines select').count();
    const disabled = await page.locator('#order-lines input, #order-lines select')
      .evaluateAll(els => els.filter(e => e.disabled).length);
    r.check('已確認明細全部唯讀', disabled, total);
    r.check('已確認隱藏存為草稿', await page.locator('#btn-save-draft').isHidden(), true);
    await page.locator('#order-modal .close-btn').first().click();
  }

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
