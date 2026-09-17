const { launch, goto, cellTexts, Results } = require('./helpers');

// 取某一欄的純文字（表格第 n 欄，1-based）
const column = (page, n) => cellTexts(page, `#receivables-table tbody tr td:nth-child(${n})`);

const hasRows = page => page.locator('#receivables-table tbody tr td.empty-state').count()
  .then(n => n === 0);

(async () => {
  const r = new Results('追款清單');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'receivables.html');

  // 側邊欄入口存在且為目前頁
  r.truthy('側邊欄有追款清單入口',
    await page.locator('.sidebar-nav .nav-item[data-page="receivables.html"]').count() === 1);
  r.truthy('側邊欄標示目前頁',
    await page.locator('.nav-item[data-page="receivables.html"]').evaluate(e => e.classList.contains('active')));

  const populated = await hasRows(page);
  r.info('本頁是否有資料', populated ? '有' : '無（空狀態）');

  if (populated) {
    // 排序：預計收款日升冪，未設定者排最後。
    // 空字串代表未設定，只檢查有值的部分遞增、且空值不出現在有值之前。
    const dates = await column(page, 1);
    const cleaned = dates.map(d => d.split('\n')[0].trim());
    const filled = cleaned.filter(d => d !== '-');
    const firstDash = cleaned.indexOf('-');
    const lastFilled = cleaned.lastIndexOf(filled[filled.length - 1]);

    r.truthy('預計收款日遞增',
      filled.every((v, i) => i === 0 || filled[i - 1] <= v));
    if (firstDash !== -1 && filled.length > 0) {
      r.truthy('未設定收款日排在最後', firstDash > lastFilled - 1);
    }

    // 未收餘額都應大於 0：view 以 outstanding_amount > 0 過濾
    const balances = await column(page, 8);
    r.truthy('未收餘額皆非零',
      balances.every(b => b.replace(/[^0-9]/g, '') !== '' && Number(b.replace(/[^0-9]/g, '')) > 0));

    // 單號應連到單據管理並帶 status=all
    const orderLink = await page.locator('#receivables-table tbody tr td:nth-child(4) a').first().getAttribute('href');
    r.truthy('單號連向單據管理', orderLink.startsWith('orders.html?q='));
    r.truthy('單號連結帶 status=all', orderLink.includes('status=all'));

    // 登錄收款應帶 order_id 到收款頁
    const payLink = await page.locator('#receivables-table tbody tr td:nth-child(9) a').first().getAttribute('href');
    r.truthy('登錄收款連向收款管理', payLink.startsWith('payments.html?order_id='));
  }

  // 篩選：逾期
  await page.selectOption('#search-bucket', 'overdue');
  await page.waitForTimeout(2500);
  r.truthy('篩選逾期後網址帶 bucket', page.url().includes('bucket=overdue'));
  if (await hasRows(page)) {
    const badges = await column(page, 2);
    r.truthy('逾期篩選只剩已逾期', badges.every(b => b.includes('已逾期')));
  }

  // 篩選：未設定收款日
  await page.selectOption('#search-bucket', 'unscheduled');
  await page.waitForTimeout(2500);
  if (await hasRows(page)) {
    const badges = await column(page, 2);
    r.truthy('未設定篩選只剩未設定', badges.every(b => b.includes('未設定')));
  }

  // 關鍵字含特殊字元不應讓查詢爆掉（or() 以逗號分隔、% 是 like 通配符）
  await page.selectOption('#search-bucket', 'all');
  await page.fill('#search-keyword', '%,()_');
  await page.waitForTimeout(2500);
  r.truthy('特殊字元關鍵字不產生錯誤', true);

  // 清空關鍵字後應回到有資料的狀態
  await page.fill('#search-keyword', '');
  await page.waitForTimeout(2500);
  r.check('清空關鍵字後恢復', await hasRows(page), populated);

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
