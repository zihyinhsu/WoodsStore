const { launch, goto, cellTexts, isAscending, isDescending, Results } = require('./helpers');

(async () => {
  const r = new Results('排序');
  const { browser, page, errors, blockedWrites } = await launch();

  // 商品：依編號升冪
  await goto(page, 'products.html');
  const skus = await cellTexts(page, '#products-table tbody tr td:first-child');
  r.info('商品編號', skus);
  r.truthy('商品依編號升冪', isAscending(skus));

  // 往來對象：供應商
  await goto(page, 'partners.html');
  const suppliers = await cellTexts(page, '#partners-table tbody tr td:first-child');
  r.info('供應商編號', suppliers);
  r.truthy('供應商依編號升冪', isAscending(suppliers));

  // 往來對象：客戶（跨頁需連續遞增）
  await page.locator('.tab-btn[data-type="customer"]').click();
  await page.waitForFunction(() => {
    const cell = document.querySelector('#partners-table tbody tr td');
    return cell && cell.textContent.trim().startsWith('C');
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  let customers = await cellTexts(page, '#partners-table tbody tr td:first-child');
  if (!(await page.isDisabled('#btn-next-page'))) {
    await page.click('#btn-next-page');
    await page.waitForTimeout(2500);
    customers = customers.concat(await cellTexts(page, '#partners-table tbody tr td:first-child'));
  }
  r.info('客戶編號', customers);
  r.truthy('客戶依編號升冪', isAscending(customers));
  r.check('客戶跨頁無重複', new Set(customers).size, customers.length);

  // 單據：依單據日期降冪
  await goto(page, 'orders.html');
  const orderDates = await cellTexts(page, 'tr.clickable-row td:first-child');
  r.info('單據日期', orderDates);
  r.truthy('單據依日期降冪', isDescending(orderDates));

  // 收款：依收款日期降冪
  await goto(page, 'payments.html');
  const paymentDates = await cellTexts(page, '#payments-table tbody tr td:first-child');
  r.info('收款日期', paymentDates);
  r.truthy('收款依日期降冪', isDescending(paymentDates));

  // 總覽近期單據：依單據日期降冪（而非建立時間）
  await goto(page, 'index.html');
  await page.waitForTimeout(1500);
  const recentDates = await cellTexts(page, '#recent-orders-table tbody tr td:first-child').catch(() => []);
  if (recentDates.length) {
    r.info('近期單據日期', recentDates);
    r.truthy('近期單據依日期降冪', isDescending(recentDates));
  }

  r.finish(errors, blockedWrites);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
