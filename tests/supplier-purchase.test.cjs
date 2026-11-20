const { launch, goto, cellTexts, isDescending, Results } = require('./helpers');

// 金額欄是 formatCurrency 的輸出（$1,234 / -$1,234），比數值大小前要剝掉符號。
const toNumber = text => Number(String(text).replace(/[^\d.-]/g, '')) || 0;

const supplierRows = page => page.$$eval('#supplier-purchase-table tbody tr', rows =>
  rows.map(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 5) return null;
    return {
      name: cells[0].textContent.trim(),
      purchase: cells[1].textContent.trim(),
      returned: cells[2].textContent.trim(),
      net: cells[3].textContent.trim()
    };
  }).filter(Boolean)
);

(async () => {
  const r = new Results('供應商進貨');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'index.html');

  // ---- 版面：第三個 tab，預設隱藏，點了才顯示 ----
  r.truthy('供應商進貨面板預設隱藏', !(await page.locator('#cost-panel-suppliers').isVisible()));
  await page.click('.tab-btn[data-view="suppliers"]');
  await page.waitForTimeout(500);
  r.truthy('點 tab 後面板顯示', await page.locator('#cost-panel-suppliers').isVisible());
  r.truthy('客戶毛利面板隱藏', !(await page.locator('#cost-panel-charts').isVisible()));

  const rows = await supplierRows(page);
  const hasData = rows.length > 0;
  r.info('供應商列數', rows.length);

  if (!hasData) {
    const empty = await page.locator('#supplier-purchase-table tbody .empty-state').innerText();
    r.info('空狀態文案', empty.trim());
    r.truthy('無資料時顯示空狀態', empty.includes('沒有供應商進貨紀錄'));
  } else {
    // ---- 每列淨進貨 = 進貨 + 退出（退出為負數；SQL 端由兩個已進位的欄位相加，必須逐列對得起來）----
    const badRow = rows.find(row =>
      Math.abs(toNumber(row.purchase) + toNumber(row.returned) - toNumber(row.net)) > 0.01
    );
    r.info('第一列', `${rows[0].name.split('\n')[0]} / ${rows[0].purchase} + ${rows[0].returned} = ${rows[0].net}`);
    r.truthy('每列淨進貨＝進貨＋退出', !badRow);

    const nets = rows.map(row => toNumber(row.net));
    r.info('淨進貨序列', nets);
    r.truthy('依淨進貨遞減排序', isDescending(nets));

    // ---- 合計不可大於卡片：卡片多含未指定供應商的進貨單，兩者口徑相同 ----
    r.truthy('合計列已顯示', await page.locator('#supplier-purchase-summary').isVisible());
    const summary = await page.locator('#supplier-purchase-summary').innerText();
    r.info('合計', summary.replace(/\s+/g, ' ').trim());
    const card = await page.locator('#stat-month-expense').innerText();
    const netMatch = summary.match(/淨進貨\s*(-?\$[\d,.]+)/);
    r.truthy('合計含淨進貨金額', !!netMatch);
    if (netMatch) {
      r.info('卡片本月進貨成本', card.trim());
      // 預設區間即本月，與卡片同期。容許逐供應商進位的尾差。
      r.truthy('供應商淨進貨合計 ≤ 本月進貨成本', toNumber(netMatch[1]) <= toNumber(card) + 1);
    }
  }

  // ---- 點列開 modal：標題帶供應商名、四張卡、明細表或空狀態 ----
  if (hasData) {
    const firstName = rows[0].name.split('\n')[0].trim();

    await page.click('#supplier-purchase-table tbody tr:first-child');
    await page.waitForTimeout(2500);

    r.check('modal 已開啟', await page.locator('#supplier-purchase-modal.active').count(), 1);
    const title = await page.locator('#supplier-purchase-title').innerText();
    r.info('modal 標題', title);
    r.truthy('標題含供應商名稱', title.includes(firstName));

    const cards = await cellTexts(page, '#supplier-purchase-modal .metric-card-title');
    r.info('卡片', cards);
    r.check('四張卡齊全', cards.length, 4);
    r.truthy('含未付餘額卡', cards.includes('目前未付餘額'));

    // modal 淨進貨卡與清單那一列同一支 RPC、同一區間，必須相等
    const netCard = await page.locator('#supplier-purchase-modal .metric-card:nth-child(3) .metric-card-value').innerText();
    r.check('modal 淨進貨＝清單該列', netCard.trim(), rows[0].net);

    const hasTable = await page.locator('#supplier-purchase-modal .records-table').count();
    r.check('有進貨就有明細表', hasTable, 1);

    // 單號連到進出貨管理
    const link = await page.locator('#supplier-purchase-modal .records-table tbody tr:first-child a').getAttribute('href');
    r.info('單號連結', link);
    r.truthy('單號可連到進出貨管理', (link || '').startsWith('orders.html?q='));

    await page.click('#supplier-purchase-modal .btn-quick-date[data-range="all"]');
    await page.waitForTimeout(2500);
    r.check('改區間後標題不變', await page.locator('#supplier-purchase-title').innerText(), title);
    r.check('改區間後為累計', await page.inputValue('#supplier-purchase-modal .range-date-from'), '');

    await page.click('#supplier-purchase-modal .close-btn');
    await page.waitForTimeout(300);
    r.check('modal 可關閉', await page.locator('#supplier-purchase-modal.active').count(), 0);
  }

  // ---- 收付款頁：付款分頁的應付餘額列走同一個 modal，區間預設累計（對應表上的全期間累計）----
  await goto(page, 'payments.html');
  await page.click('.tab-btn[data-dir="out"]');
  await page.waitForTimeout(2500);
  // 預設只列未結清的供應商，全部結清時表格會是空的；勾選顯示已結清才有列可點。
  if (await page.locator('#balance-table tbody tr.clickable-row').count() === 0) {
    await page.check('#toggle-settled');
    await page.waitForTimeout(2500);
  }

  const balanceRows = await page.locator('#balance-table tbody tr.clickable-row').count();
  r.info('應付餘額可點列數', balanceRows);

  if (balanceRows > 0) {
    await page.click('#balance-table tbody tr.clickable-row:first-child');
    await page.waitForTimeout(2500);
    r.check('應付餘額點列開進貨 modal', await page.locator('#supplier-purchase-modal.active').count(), 1);
    r.check('區間預設累計（開始日空白）', await page.inputValue('#supplier-purchase-modal .range-date-from'), '');
    r.check('區間預設累計（結束日空白）', await page.inputValue('#supplier-purchase-modal .range-date-to'), '');
    await page.click('#supplier-purchase-modal .close-btn');
    await page.waitForTimeout(300);
  }

  // 收款分頁的客戶列不可點：客戶的分析在總覽與往來對象頁
  await page.click('.tab-btn[data-dir="in"]');
  await page.waitForTimeout(2500);
  r.check('應收餘額列不可點', await page.locator('#balance-table tbody tr.clickable-row').count(), 0);

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
