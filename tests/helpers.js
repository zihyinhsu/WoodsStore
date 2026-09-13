const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4173';

const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];
const WRITE_RPCS = /\/rpc\/(create_order|update_draft_order|update_order_meta|confirm_order|void_order|save_payment_with_allocations)/;

/**
 * 開啟瀏覽器並預設攔截所有寫入請求。
 * 這個專案直連正式 Supabase，沒有測試資料庫；
 * 若不攔截，跑一次測試就會在正式環境留下垃圾資料。
 */
async function launch({ allowWrites = false } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const errors = [];
  const blockedWrites = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  if (!allowWrites) {
    await page.route('**/rest/v1/**', route => {
      const req = route.request();
      const url = req.url();
      const isWrite = WRITE_METHODS.includes(req.method())
        && (req.method() !== 'POST' || WRITE_RPCS.test(url) || /\/rest\/v1\/[a-z_]+(\?|$)/.test(url));

      if (isWrite) {
        blockedWrites.push(`${req.method()} ${url.split('/rest/v1/')[1]}`);
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
      }
      return route.continue();
    });
  }

  return { browser, page, errors, blockedWrites };
}

async function goto(page, path) {
  await page.goto(`${BASE_URL}/${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
}

const cellTexts = (page, selector) =>
  page.locator(selector).allInnerTexts().then(a => a.map(s => s.trim()));

const isAscending = arr => arr.every((v, i) => i === 0 || arr[i - 1] <= v);
const isDescending = arr => arr.every((v, i) => i === 0 || arr[i - 1] >= v);

class Results {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = [];
  }

  check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      this.passed++;
      console.log(`  PASS  ${label}`);
    } else {
      this.failed.push(label);
      console.log(`  FAIL  ${label}`);
      console.log(`        expected: ${JSON.stringify(expected)}`);
      console.log(`        actual:   ${JSON.stringify(actual)}`);
    }
    return ok;
  }

  truthy(label, actual) {
    return this.check(label, Boolean(actual), true);
  }

  info(label, value) {
    console.log(`  ....  ${label}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }

  finish(errors = [], blockedWrites = []) {
    if (errors.length) {
      this.failed.push('console errors');
      console.log(`  FAIL  console errors: ${JSON.stringify(errors)}`);
    }
    if (blockedWrites.length) {
      console.log(`  NOTE  blocked writes: ${JSON.stringify(blockedWrites)}`);
    }
    const total = this.passed + this.failed.length;
    console.log(`\n${this.name}: ${this.passed}/${total} passed`);
    if (this.failed.length) {
      console.log(`FAILED: ${this.failed.join(', ')}`);
      process.exitCode = 1;
    }
    return this.failed.length === 0;
  }
}

module.exports = {
  BASE_URL, launch, goto, cellTexts,
  isAscending, isDescending, Results
};
