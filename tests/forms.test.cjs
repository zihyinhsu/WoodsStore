const { launch, goto, Results } = require('./helpers');

(async () => {
  const r = new Results('表單與防連點');
  const { browser, page, errors } = await launch({ allowWrites: true });

  // 只註冊一個 route：Playwright 後註冊者優先，
  // 多個 handler 會互相搶截，導致計數收不到請求。
  // POST 刻意延遲回應，重現「按了沒反應就連點」的情境。
  let insertAttempts = 0;
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      if (req.url().includes('/rest/v1/products')) insertAttempts++;
      await new Promise(res => setTimeout(res, 2000));
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    }
    if (['PATCH', 'PUT', 'DELETE'].includes(req.method())) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    return route.continue();
  });

  await goto(page, 'products.html');

  // 商品新增：編號可留空、提示可見
  await page.click('#btn-add-product');
  await page.waitForTimeout(600);
  r.check('新增商品標題', (await page.textContent('#modal-title')).trim(), '新增商品');
  r.check('編號預設空白', await page.inputValue('#product-sku'), '');
  r.check('編號非必填', await page.getAttribute('#product-sku', 'required'), null);
  r.truthy('顯示自動編號提示', await page.locator('#product-sku-hint').isVisible());

  await page.fill('#product-name', '防連點測試');
  r.truthy('編號留空仍可送出', await page.evaluate(
    () => document.getElementById('product-form').checkValidity()));

  // 連點五次只能送出一次
  const btn = page.locator('#btn-save-product');
  await btn.click();
  await page.waitForTimeout(150);
  r.check('送出中顯示處理中', (await page.textContent('#btn-save-product')).trim(), '處理中...');
  r.truthy('送出中停用按鈕', await page.isDisabled('#btn-save-product'));

  for (let i = 0; i < 4; i++) {
    await btn.click({ force: true, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(3500);
  r.check('連點五次只送出一次', insertAttempts, 1);
  r.check('完成後還原按鈕文字', (await page.textContent('#btn-save-product')).trim(), '儲存');
  r.truthy('完成後恢復可用', !(await page.isDisabled('#btn-save-product')));

  // 編輯既有商品時不顯示自動編號提示
  await goto(page, 'products.html');
  const editBtn = page.locator('.btn-edit').first();
  if (await editBtn.count() > 0) {
    await editBtn.click();
    await page.waitForTimeout(900);
    r.check('編輯商品標題', (await page.textContent('#modal-title')).trim(), '編輯商品');
    r.check('編輯時隱藏自動編號提示', await page.locator('#product-sku-hint').isVisible(), false);
    r.truthy('編輯時帶出原編號', (await page.inputValue('#product-sku')).length > 0);
    await page.locator('#product-modal .close-btn').first().click();
  }

  // 往來對象：同樣的自動編號提示行為
  await goto(page, 'partners.html');
  await page.click('#btn-add-partner');
  await page.waitForTimeout(600);
  r.truthy('新增往來對象顯示提示', await page.locator('#partner-no-hint').isVisible());
  await page.locator('#partner-modal .close-btn').first().click();
  await page.waitForTimeout(400);

  const editPartner = page.locator('.btn-edit').first();
  if (await editPartner.count() > 0) {
    await editPartner.click();
    await page.waitForTimeout(800);
    r.check('編輯往來對象隱藏提示', await page.locator('#partner-no-hint').isVisible(), false);
    await page.locator('#partner-modal .close-btn').first().click();
  }

  // 單據頁動態按鈕文案不被防連點覆蓋
  await goto(page, 'orders.html');
  await page.click('#btn-add-order');
  await page.waitForTimeout(600);
  r.check('新增單據按鈕文案', (await page.textContent('#btn-save-order')).trim(), '建立單據');
  r.check('存為草稿按鈕文案', (await page.textContent('#btn-save-draft')).trim(), '存為草稿');

  r.finish(errors);
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
