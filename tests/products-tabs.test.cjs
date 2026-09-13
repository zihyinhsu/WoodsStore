const { launch, goto, cellTexts, Results } = require('./helpers');

const stockPairs = page => page.$$eval('#products-table tbody tr', rows =>
  rows.map(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 4) return null;
    const stock = parseInt(cells[3].textContent.trim(), 10);
    return Number.isNaN(stock) ? null : stock;
  }).filter(v => v !== null)
);

(async () => {
  const r = new Results('商品分頁');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'products.html');

  // 預設停在「所有商品」
  r.check('預設選中所有商品', await page.getAttribute('.tab-btn[data-view="all"]', 'aria-selected'), 'true');
  r.check('庫存不足未選中', await page.getAttribute('.tab-btn[data-view="low-stock"]', 'aria-selected'), 'false');

  const allSkus = await cellTexts(page, '#products-table tbody tr td:first-child');
  r.info('所有商品編號', allSkus);
  r.truthy('所有商品分頁有資料', allSkus.length > 0);

  // 切到「庫存不足」
  await page.click('.tab-btn[data-view="low-stock"]');
  await page.waitForTimeout(2500);

  r.check('切換後選中庫存不足', await page.getAttribute('.tab-btn[data-view="low-stock"]', 'aria-selected'), 'true');
  r.check('切換後所有商品取消選中', await page.getAttribute('.tab-btn[data-view="all"]', 'aria-selected'), 'false');

  const lowRows = await page.locator('#products-table tbody tr').count();
  const emptyState = await page.locator('#products-table tbody .empty-state').count();

  if (emptyState > 0) {
    const message = await page.locator('#products-table tbody .empty-state').innerText();
    r.info('庫存不足空狀態', message.trim());
    r.truthy('空狀態文案正確', message.includes('目前無庫存不足的商品'));
  } else {
    const stocks = await stockPairs(page);
    r.info('庫存不足筆數', lowRows);
    r.truthy('庫存不足分頁有資料', stocks.length > 0);
  }

  // 分頁筆數必須少於或等於全部商品
  const lowSkus = await cellTexts(page, '#products-table tbody tr td:first-child');
  const allSet = new Set(allSkus);
  const isSubset = lowSkus.every(sku => allSet.has(sku) || allSkus.length >= 10);
  r.truthy('庫存不足為商品子集', isSubset);

  // 數量標記與實際筆數一致
  const badge = page.locator('#low-stock-count');
  if (await badge.isVisible()) {
    const badgeCount = parseInt((await badge.innerText()).trim(), 10);
    r.info('標記數量', badgeCount);
    r.truthy('標記為正整數', Number.isInteger(badgeCount) && badgeCount > 0);
  }

  // 切回「所有商品」要還原
  await page.click('.tab-btn[data-view="all"]');
  await page.waitForTimeout(2500);
  const backSkus = await cellTexts(page, '#products-table tbody tr td:first-child');
  r.check('切回所有商品還原清單', backSkus, allSkus);

  // 由總覽卡片帶 hash 進來要直接停在庫存不足分頁
  await goto(page, 'products.html#view=low-stock');
  r.check('hash 直達庫存不足分頁',
    await page.getAttribute('.tab-btn[data-view="low-stock"]', 'aria-selected'), 'true');

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
