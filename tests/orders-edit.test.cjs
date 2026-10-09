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
  const byStatus = await page.locator('tr.clickable-row:not(.group-row)').evaluateAll(trs => {
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

  // 接續單據只適用進貨／出貨；調整單在新增時已藏起，改用 evaluate 直接切值觸發 change。
  const parentVisible = () => page.locator('#order-parent-group').isVisible();
  await page.selectOption('#order-type', 'purchase');
  await page.waitForTimeout(300);
  r.check('進貨單顯示接續單據', await parentVisible(), true);
  await page.selectOption('#order-type', 'sale');
  await page.waitForTimeout(300);
  r.check('出貨單顯示接續單據', await parentVisible(), true);
  await page.evaluate(() => {
    const el = document.getElementById('order-type');
    el.value = 'adjust';
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(300);
  r.check('調整單隱藏接續單據', await parentVisible(), false);
  r.check('未選對象時只有「新的一批」', await page.locator('#order-parent option').count(), 1);

  await page.locator('#order-modal .close-btn').first().click();
  await page.waitForTimeout(500);

  // 草稿：表頭與明細可編輯，僅類型鎖定
  const draftRow = page.locator('tr.clickable-row:not(.group-row)').filter({ hasText: '草稿' }).first();
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
  const confirmedRow = page.locator('tr.clickable-row:not(.group-row)').filter({ hasText: '已確認' }).first();
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

    // 接續單據屬於 metadata，與備註一樣在已確認後仍可補設；只有「已是原單」時鎖住。
    const isRoot = await confirmedRow.locator('.batch-link').filter({ hasText: '共' }).count() > 0;
    r.check('已確認接續單據可否修改', await page.isDisabled('#order-parent'), isRoot);
    await page.locator('#order-modal .close-btn').first().click();
    await page.waitForTimeout(500);
  }

  // 合併顯示（預設）：分批單據一組一列，組列本身不放操作鈕，展開後各批各有自己的操作。
  r.check('預設為合併分批顯示', await page.inputValue('#search-view'), 'group');
  const groupRow = page.locator('tr.group-row').first();
  if (await groupRow.count() > 0) {
    r.check('組列沒有編輯按鈕', await groupRow.locator('.btn-edit').count(), 0);
    r.truthy('組列顯示往來對象', (await groupRow.locator('td').nth(4).innerText()).trim() !== '-');
    await groupRow.locator('td').nth(1).click();
    await page.waitForTimeout(2500);
    const blocks = page.locator('.detail-row .batch-block');
    r.truthy('展開後逐批列出（至少兩批）', await blocks.count() >= 2);
    r.check('每批都有自己的明細表',
      await page.locator('.detail-row .batch-block .detail-table').count(), await blocks.count());
    await groupRow.locator('td').nth(1).click();
    await page.waitForTimeout(600);
  } else {
    r.info('略過組列驗證', '目前查詢範圍內沒有分批（接續原單）的單據');
  }

  // 逐張顯示：回到一張單一列，網址記住選擇。批次標示的驗證在這個模式下做，接續單才會單獨成列。
  await page.selectOption('#search-view', 'flat');
  await page.waitForTimeout(2500);
  r.check('逐張顯示寫入網址', new URL(page.url()).searchParams.get('view'), 'flat');
  r.check('逐張顯示沒有組列', await page.locator('tr.group-row').count(), 0);

  // 批次標示：點「接續 X／共 N 批」以原單號篩出整組，且不展開明細。正式資料不保證有分批單。
  const batchLink = page.locator('.batch-link').first();
  if (await batchLink.count() > 0) {
    const rootNo = await batchLink.getAttribute('data-root-no');
    await batchLink.click();
    await page.waitForTimeout(2500);
    r.check('點批次標示帶入原單號', await page.inputValue('#search-keyword'), rootNo);
    r.check('點批次標示清空日期起', await page.inputValue('#search-date-from'), '');
    r.check('點批次標示不展開明細', await page.locator('.detail-row').count(), 0);
    const nos = await page.locator('tr.clickable-row').allInnerTexts();
    r.truthy('篩出的單都屬於同一組', nos.length > 0 && nos.every(t => t.includes(rootNo)));
  } else {
    r.info('略過批次標示驗證', '目前沒有分批（接續原單）的單據');
  }

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
