const { launch, goto, cellTexts, isDescending, Results } = require('./helpers');

// 金額欄是 formatCurrency 的輸出（NT$1,234 / -NT$1,234），比數值大小前要剝掉符號。
const toNumber = text => Number(String(text).replace(/[^\d.-]/g, '')) || 0;

const profitRows = page => page.$$eval('#partner-profit-table tbody tr', rows =>
  rows.map(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 5) return null;
    return {
      name: cells[0].textContent.trim(),
      sale: cells[1].textContent.trim(),
      cost: cells[2].textContent.trim(),
      profit: cells[3].textContent.trim(),
      margin: cells[4].textContent.trim()
    };
  }).filter(Boolean)
);

(async () => {
  const r = new Results('客戶毛利');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'index.html');

  // ---- 版面：客戶毛利面板預設可見，左圖右表同時在場 ----
  r.truthy('客戶毛利面板預設顯示', await page.locator('#cost-panel-charts').isVisible());
  r.check('排行圖 canvas 存在', await page.locator('#partner-profit-chart').count(), 1);
  r.check('客戶毛利表格存在', await page.locator('#partner-profit-table').count(), 1);
  r.check('關鍵字搜尋框存在', await page.locator('#partner-profit-search').count(), 1);

  const rows = await profitRows(page);
  const hasData = rows.length > 0;
  r.info('客戶毛利列數', rows.length);

  if (!hasData) {
    // 本月可能真的還沒有出貨（月初、或全是無客戶單據），此時空狀態必須出現而非空白表格。
    const empty = await page.locator('#partner-profit-table tbody .empty-state').innerText();
    r.info('空狀態文案', empty.trim());
    r.truthy('無資料時顯示空狀態', empty.includes('沒有客戶出貨紀錄'));
  } else {
    // ---- 每列的毛利必須等於出貨額 − 出貨成本（口徑由 SQL 決定，這裡驗前端沒算錯）----
    const badRow = rows.find(row =>
      Math.abs((toNumber(row.sale) - toNumber(row.cost)) - toNumber(row.profit)) > 1
    );
    r.info('第一列', `${rows[0].name} / ${rows[0].sale} − ${rows[0].cost} = ${rows[0].profit}`);
    r.truthy('每列毛利＝出貨額−出貨成本', !badRow);

    // ---- 預設依毛利由高到低（partner_no 為並列時的決勝鍵）----
    const profits = rows.map(row => toNumber(row.profit));
    r.info('毛利序列', profits);
    r.truthy('依毛利遞減排序', isDescending(profits));

    // ---- 合計列：與清單同一支 RPC 加總，必須顯示且為金額 ----
    r.truthy('合計列已顯示', await page.locator('#partner-profit-summary').isVisible());
    const summary = await page.locator('#partner-profit-summary').innerText();
    r.info('合計', summary.replace(/\s+/g, ' ').trim());
    // formatCurrency 以 zh-TW 輸出，貨幣符號是 $ 而非 NT$；負數為 -$1,234
    r.truthy('合計含毛利金額', /毛利\s*-?\$[\d,]+/.test(summary));
  }

  // ---- 改關鍵字：頁碼歸 1，且結果只留命中的客戶 ----
  if (hasData) {
    const keyword = rows[0].name.split('\n')[0].slice(0, 2);
    await page.fill('#partner-profit-search', keyword);
    await page.waitForTimeout(2000);

    const filtered = await profitRows(page);
    r.info(`搜尋「${keyword}」後列數`, filtered.length);
    r.truthy('搜尋後仍有結果', filtered.length > 0);
    r.check('搜尋後回到第 1 頁',
      (await page.locator('#partner-profit-list-page-info').innerText()).includes('第 1 /'), true);

    await page.fill('#partner-profit-search', '');
    await page.waitForTimeout(2000);
  }

  // ---- 排行圖 hover：tooltip 畫在 canvas 上讀不到文字，改驗同一條 hover 管線的副作用
  //      （游標變 pointer）。游標有反應代表 chart.js 有認到那一列，tooltip 也就畫得出來。 ----
  if (hasData) {
    const box = await page.locator('#partner-profit-chart').boundingBox();
    // 第一根長條在最上面；intersect: false 讓該列任何 x 位置都算命中。
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.12);
    await page.waitForTimeout(500);

    const cursor = await page.locator('#partner-profit-chart').evaluate(el => el.style.cursor);
    r.info('長條上的游標', cursor || '(未設定)');
    r.check('hover 長條時游標變 pointer', cursor, 'pointer');

    // 移出圖表範圍要還原，否則整張圖看起來都可點
    await page.mouse.move(box.x + box.width * 0.25, box.y - 30);
    await page.waitForTimeout(500);
    r.check('移開後游標還原', await page.locator('#partner-profit-chart').evaluate(el => el.style.cursor), 'default');
  }

  // ---- 點列開 modal：標題帶客戶名、商品組成與四張卡都要在 ----
  if (hasData) {
    const firstName = (await page.locator('#partner-profit-table tbody tr:first-child td:first-child').innerText())
      .split('\n')[0].trim();

    await page.click('#partner-profit-table tbody tr:first-child');
    await page.waitForTimeout(2500);

    r.truthy('modal 已開啟', await page.locator('#partner-profit-modal.active').count() === 1);
    const title = await page.locator('#partner-profit-title').innerText();
    r.info('modal 標題', title);
    r.truthy('標題含客戶名稱', title.includes(firstName));

    const cards = await cellTexts(page, '#partner-profit-modal .metric-card-title');
    r.info('卡片', cards);
    r.check('四張卡齊全', cards.length, 4);
    r.truthy('含未收餘額卡', cards.includes('目前未收餘額'));

    // 未收餘額是全期間期末快照，與上方區間毛利不同口徑，必須標註避免誤讀
    const subtitles = await cellTexts(page, '#partner-profit-modal .metric-card-subtitle');
    r.truthy('未收餘額有標註口徑', subtitles.some(s => s.includes('全期間累計')));

    // 商品組成：有出貨就該有表格，沒有則顯示空狀態（兩者互斥）
    const hasTable = await page.locator('#partner-profit-modal .records-table').count();
    const hasEmpty = await page.locator('#partner-profit-modal .empty-state').count();
    r.truthy('商品組成有表格或空狀態', (hasTable === 1) !== (hasEmpty === 1));

    // ---- 改 modal 區間：資料要重查，標題不可跟著跑掉（競態閘門）----
    await page.click('#partner-profit-modal .btn-quick-date[data-range="all"]');
    await page.waitForTimeout(2500);
    r.check('改區間後標題不變', await page.locator('#partner-profit-title').innerText(), title);
    r.check('改區間後仍為累計', await page.inputValue('#partner-profit-modal .profit-date-from'), '');

    await page.click('#partner-profit-modal .close-btn');
    await page.waitForTimeout(300);
    r.check('modal 可關閉', await page.locator('#partner-profit-modal.active').count(), 0);
  }

  // ---- 往來對象頁的客戶列走同一個 modal ----
  await goto(page, 'partners.html');
  await page.click('.tab-btn[data-type="customer"]');
  await page.waitForTimeout(2500);

  const customerRows = await page.locator('#partners-table tbody tr.clickable-row').count();
  r.info('客戶列數', customerRows);

  if (customerRows > 0) {
    await page.click('#partners-table tbody tr.clickable-row:first-child');
    await page.waitForTimeout(2500);
    r.check('往來對象點列開毛利 modal', await page.locator('#partner-profit-modal.active').count(), 1);

    // 編輯鈕不可被列點擊搶走，否則兩個 modal 會同時開
    await page.click('#partner-profit-modal .close-btn');
    await page.waitForTimeout(300);
    await page.click('#partners-table tbody tr.clickable-row:first-child .btn-edit');
    await page.waitForTimeout(500);
    r.check('點編輯鈕只開編輯 modal', await page.locator('#partner-modal.active').count(), 1);
    r.check('點編輯鈕不開毛利 modal', await page.locator('#partner-profit-modal.active').count(), 0);

    // 編輯 modal 是 fixed 覆蓋層，不關掉會擋住後面要點的 tab
    await page.click('#partner-modal .modal-header .close-btn');
    await page.waitForTimeout(300);
  }

  // 供應商分頁沒有毛利可談（毛利一律從出貨算），不該可點
  await page.click('.tab-btn[data-type="supplier"]');
  await page.waitForTimeout(2500);
  r.check('供應商列不可點', await page.locator('#partners-table tbody tr.clickable-row').count(), 0);

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
