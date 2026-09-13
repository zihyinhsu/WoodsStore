const { launch, goto, cellTexts, Results } = require('./helpers');

const text = (page, selector) => page.locator(selector).innerText().then(s => s.trim());
const isCurrency = value => /^(-?NT\$|\$-?)/.test(value);

(async () => {
  const r = new Results('總覽');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'index.html');

  // 四個本月指標都要算出金額，而非停在初始的 "-"
  for (const [label, id] of [
    ['本月出貨收益', '#stat-month-revenue'],
    ['本月進貨支出', '#stat-month-expense'],
    ['本月出貨成本', '#stat-month-cost'],
    ['本月毛利', '#stat-month-profit']
  ]) {
    const value = await text(page, id);
    r.info(label, value);
    r.truthy(`${label}顯示金額`, isCurrency(value));
  }

  // 移除的區塊不得殘留
  r.check('近期單據數已移除', await page.locator('#stat-recent-orders').count(), 0);
  r.check('最新單據已移除', await page.locator('#recent-orders-table').count(), 0);
  r.check('庫存不足清單已移至商品頁', await page.locator('#low-stock-table').count(), 0);

  // 商品總數與庫存不足卡片已移除
  r.check('商品總數卡片已移除', await page.locator('#stat-total-products').count(), 0);
  r.check('庫存不足卡片已移除', await page.locator('#stat-low-stock').count(), 0);

  // 日期區間預設為本月一日到月底
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const expectedFrom = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`;
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const expectedTo = `${lastDay.getFullYear()}-${pad(lastDay.getMonth() + 1)}-${pad(lastDay.getDate())}`;

  r.check('預設開始日期為本月一日', await page.inputValue('#cost-date-from'), expectedFrom);
  r.check('預設結束日期為本月月底', await page.inputValue('#cost-date-to'), expectedTo);

  // 成本分析表格：有資料時每列欄位齊全，無資料時顯示空狀態
  const rowCount = await page.locator('#cost-table tbody tr').count();
  const firstRowCells = await page.locator('#cost-table tbody tr:first-child td').count();
  r.info('成本分析列數', rowCount);
  r.truthy('成本分析表格有內容', rowCount > 0);
  r.truthy('欄位數正確（7 欄或空狀態）', firstRowCells === 7 || firstRowCells === 1);

  // 合計區塊在查詢成功後顯示
  r.truthy('合計區塊已顯示', await page.locator('#cost-totals').isVisible());
  const totals = await cellTexts(page, '.cost-total-value');
  r.info('期間合計', totals);
  r.truthy('合計皆為金額', totals.length === 4 && totals.every(isCurrency));

  // 起始日晚於結束日要擋下並提示
  await page.fill('#cost-date-from', expectedTo);
  await page.fill('#cost-date-to', expectedFrom);
  await page.click('#btn-cost-search');
  await page.waitForTimeout(600);
  const toastText = await page.locator('.toast').first().innerText().catch(() => '');
  r.info('日期驗證提示', toastText);
  r.truthy('開始日晚於結束日被擋下', toastText.includes('開始日期不可晚於結束日期'));

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
