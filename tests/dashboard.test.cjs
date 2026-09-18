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
    ['本月進貨成本', '#stat-month-expense'],
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

  // 進出貨成本分析拆成兩個 tab：預設在「客戶毛利」，商品明細面板此時應隱藏
  r.check('客戶毛利 tab 預設 active', await page.locator('.tab-btn[data-view="charts"]').getAttribute('aria-selected'), 'true');
  r.truthy('客戶毛利面板預設顯示', await page.locator('#cost-panel-charts').isVisible());
  r.truthy('商品明細面板預設隱藏', !(await page.locator('#cost-panel-table').isVisible()));

  // 舊的兩張圖已由客戶毛利取代（patch-026），不得殘留
  r.check('趨勢圖已移除', await page.locator('#cost-trend-chart').count(), 0);
  r.check('商品毛利排行圖已移除', await page.locator('#cost-ranking-chart').count(), 0);

  // 圖表：canvas 容器必須存在；有資料時 canvas 顯示、空狀態隱藏（兩者互斥）
  r.check('客戶毛利排行 canvas 存在', await page.locator('#partner-profit-chart').count(), 1);

  const chartState = async (canvasId, emptyId) => {
    const visible = await page.locator(canvasId).isVisible();
    const empty = await page.locator(emptyId).isVisible();
    return { visible, empty, ok: visible !== empty };
  };

  const profit = await chartState('#partner-profit-chart', '#partner-profit-chart-empty');
  r.info('客戶毛利排行狀態', profit.visible ? '有資料' : (profit.empty ? '空狀態' : '未知'));
  r.truthy('客戶毛利排行有資料或顯示空狀態', profit.ok);

  // 切換到較寬區間重查：圖表要跟著重繪，且不得殘留舊 chart（殘留會噴 console error，由 finish 把關）
  await page.fill('#cost-date-from', `${today.getFullYear()}-01-01`);
  await page.fill('#cost-date-to', expectedTo);
  await page.click('#btn-cost-search');
  await page.waitForTimeout(1500);
  const profitAfter = await chartState('#partner-profit-chart', '#partner-profit-chart-empty');
  r.truthy('重查後排行圖仍正常（無殘留 canvas 錯誤）', profitAfter.ok);

  // 切到「商品明細」tab：面板互斥切換，表格與合計才可見
  await page.click('.tab-btn[data-view="table"]');
  await page.waitForTimeout(300);
  r.truthy('切換後明細面板顯示', await page.locator('#cost-panel-table').isVisible());
  r.truthy('切換後圖表面板隱藏', !(await page.locator('#cost-panel-charts').isVisible()));

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
  // 取「含這句話的 toast」而非第一個：畫面上同時可能還有其他 toast（例如某支 RPC 尚未套用
  // 而噴的載入失敗），拿 first() 會驗到不相干的那一則。
  const toasts = await page.locator('.toast').allInnerTexts().catch(() => []);
  r.info('日期驗證提示', toasts);
  r.truthy('開始日晚於結束日被擋下',
    toasts.some(t => t.includes('開始日期不可晚於結束日期')));

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
