const { launch, goto, Results } = require('./helpers');

const visibleSections = page => page.locator('.statement-section')
  .evaluateAll(els => els.filter(e => getComputedStyle(e).display !== 'none').length);

(async () => {
  const r = new Results('對帳單');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'statement.html');

  // 查詢前：全選列與列印按鈕都不該可用
  r.truthy('查詢前隱藏全選列', await page.locator('#statement-toolbar').isHidden());
  r.truthy('查詢前停用列印選取', await page.isDisabled('#btn-print-selected'));
  r.truthy('查詢前停用列印全部', await page.isDisabled('#btn-print-all'));

  // 查詢有資料的區間
  await page.fill('#statement-date-from', '2000-01-01');
  await page.fill('#statement-date-to', '2035-12-31');
  await page.click('#btn-search');
  await page.waitForTimeout(4000);

  const tabs = await page.locator('.statement-tab').count();
  const sections = await page.locator('.statement-section').count();
  r.info('客戶數', tabs);
  r.truthy('查到至少一位客戶', tabs > 0);
  r.check('tab 數與對帳單區塊數一致', sections, tabs);
  r.truthy('查詢後顯示全選列', await page.locator('#statement-toolbar').isVisible());
  r.check('預設全部勾選', await page.locator('.tab-check:checked').count(), tabs);
  r.check('預設只顯示一位客戶', await visibleSections(page), 1);

  // 取消勾選不應影響預覽
  // 勾選一律點 label：這些 checkbox 外觀改用全站共用的 .checkbox 後，原生 input 被
  // 設成 opacity:0/寬高 0（css/style.css 的 .checkbox input），Playwright 視為不可見，
  // 直接對 input 下 uncheck()/click() 會等到逾時。點 label 也更接近真人操作。
  const activeBefore = await page.locator('.statement-section.is-active').getAttribute('data-partner-id');
  await page.locator('.statement-tab .checkbox').first().click();
  await page.waitForTimeout(300);
  const activeAfter = await page.locator('.statement-section.is-active').getAttribute('data-partner-id');
  r.check('取消勾選不改變預覽', activeAfter, activeBefore);
  r.truthy('全選框呈半選', await page.locator('#select-all').evaluate(e => e.indeterminate));

  // 切換 tab 不應影響勾選
  if (tabs > 1) {
    const checkedBefore = await page.locator('.tab-check:checked').count();
    await page.locator('.tab-label').nth(1).click();
    await page.waitForTimeout(400);
    r.check('切換預覽不改變勾選', await page.locator('.tab-check:checked').count(), checkedBefore);
    r.check('切換後仍只顯示一位', await visibleSections(page), 1);
  }

  // 列印模式：只印勾選 / 印全部
  const selected = await page.locator('.tab-check:checked').count();
  await page.emulateMedia({ media: 'print' });

  await page.evaluate(() => {
    document.querySelectorAll('.statement-section').forEach(s => {
      const id = s.dataset.partnerId;
      const cb = document.querySelector(`.tab-check[data-partner-id="${id}"]`);
      s.classList.toggle('is-selected', Boolean(cb && cb.checked));
    });
    document.body.classList.add('print-selected');
  });
  r.check('列印選取只輸出勾選者', await visibleSections(page), selected);
  await page.evaluate(() => document.body.classList.remove('print-selected'));

  await page.evaluate(() => document.body.classList.add('print-all'));
  r.check('列印全部輸出所有客戶', await visibleSections(page), sections);
  r.check('列印時隱藏 tabs', await page.locator('#statement-tabs').evaluate(e => getComputedStyle(e).display), 'none');
  await page.evaluate(() => document.body.classList.remove('print-all'));
  await page.emulateMedia({ media: 'screen' });

  // 全選框：半選 -> 全選 -> 全不選 -> 全選
  await page.locator('.select-all-label').click();
  await page.waitForTimeout(300);
  r.check('半選點擊後全選', await page.locator('.tab-check:checked').count(), tabs);
  await page.locator('.select-all-label').click();
  await page.waitForTimeout(300);
  r.check('再點取消全選', await page.locator('.tab-check:checked').count(), 0);
  r.truthy('無勾選時停用列印', await page.isDisabled('#btn-print-selected'));

  // 查無資料：全選列應重新隱藏
  await page.fill('#statement-date-from', '1990-01-01');
  await page.fill('#statement-date-to', '1990-01-31');
  await page.click('#btn-search');
  await page.waitForTimeout(3000);
  r.truthy('查無資料時隱藏全選列', await page.locator('#statement-toolbar').isHidden());
  r.check('查無資料時無 tab', await page.locator('.statement-tab').count(), 0);

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
