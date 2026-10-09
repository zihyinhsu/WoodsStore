// Shared UI Helpers
//
// 這裡只放會操作 DOM 或瀏覽器狀態的共用元件。
// 純函式（格式化、日期換算、數值處理）請放 utils.js。
import { totalPages, escapeHtml } from './utils.js';
import { sb } from './supabase.js';

// 各頁分頁列的樣板完全一致，只差資料筆數的單位文案，
// 因此統一由這裡渲染，各頁仍自行綁定 prev/next 的載入行為。
export function renderPagination({ page, total, pageSize, unit = '筆', pageInfoId = 'page-info', prevId = 'btn-prev-page', nextId = 'btn-next-page' }) {
  const pages = totalPages(total, pageSize);

  const pageInfo = document.getElementById(pageInfoId);
  if (pageInfo) pageInfo.textContent = `第 ${page} / ${pages} 頁 (共 ${total} ${unit})`;

  const prev = document.getElementById(prevId);
  if (prev) prev.disabled = page <= 1;

  const next = document.getElementById(nextId);
  if (next) next.disabled = page >= pages;
}

// 手機版（≤768px）把清單表改為卡片：一列一張卡、每格左欄名右值，
// 取代需要左右滑動的橫向捲動（CSS 在 style.css 的 .table--cards）。
// 卡片化需要每格知道自己對應哪個欄位才能顯示欄名，但表身由各頁
// innerHTML 重繪；若要各頁在模板裡手寫 data-label，又會重蹈「同一段
// 邏輯散落多支檔案」的覆轍。因此改由這裡從 thead 自動抓欄名補到每個
// td，並用 MutationObserver 在每次重繪（分頁、搜尋、篩選）後自動補上，
// 各頁只需在初始化註冊一次。
export function setupResponsiveTable(table) {
  const el = typeof table === 'string' ? document.querySelector(table) : table;
  if (!el || !el.tHead || !el.tBodies[0]) return;

  el.classList.add('table--cards');

  const headers = [...el.tHead.rows[0].cells].map(th => th.textContent.trim());
  const tbody = el.tBodies[0];

  const label = () => {
    for (const row of tbody.rows) {
      // 只處理「一列對應一筆」的資料列；colspan 佔位列（空狀態、載入中、
      // 訂單展開明細）欄數對不上，維持原樣由 CSS 置中顯示。
      if (row.cells.length !== headers.length) continue;
      [...row.cells].forEach((td, i) => td.setAttribute('data-label', headers[i]));
    }
  };

  label();

  // 只看子節點增減（整個 tbody 被重繪），不看屬性——否則上面的
  // setAttribute 會反覆觸發自己。
  new MutationObserver(label).observe(tbody, { childList: true });
}

// 防連點：非同步儲存回應前先鎖住按鈕。
// 不能只用節流，請求較慢時仍會漏掉後續點擊而重複送出。
export function bindSubmitOnce(buttonId, handler) {
  const button = document.getElementById(buttonId);
  if (!button) return;

  let running = false;

  button.addEventListener('click', async (event) => {
    if (running) return;
    running = true;

    // 還原點擊當下的文字，而非綁定當下：
    // 單據頁的按鈕文案會依新增/草稿/已確認模式變動。
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = '處理中...';

    try {
      await handler(event);
    } finally {
      running = false;
      button.disabled = false;
      button.textContent = previousText;
    }
  });
}

const UNIQUE_FIELD_LABELS = {
  products_sku_key: '商品編號',
  partners_partner_no_key: '客戶編號',
  payments_payment_no_key: '收付款單號',
  orders_order_no_key: '單號'
};

const FOREIGN_KEY_MESSAGE = '此筆資料已被其他單據使用，無法刪除或修改。';

export function toErrorMessage(error) {
  const raw = error?.message || '';

  if (raw.includes('ORDER_NOT_EDITABLE')) {
    return '此單據狀態已變更（可能已被確認或作廢），無法編輯。請重新整理後再試。';
  }
  if (raw.includes('ORDER_NOT_FOUND')) return '找不到此單據，可能已被刪除。';

  // 接續原單（patch-028）的訊息在 DB 端已寫成中文並帶上原單單號，去掉代碼前綴即可直接顯示。
  const parentError = raw.match(/(?:ORDER_PARENT_[A-Z]+|ORDER_HAS_CHILDREN):\s*(.+)/);
  if (parentError) return parentError[1];

  if (raw.includes('PAYMENT_STATUS_READONLY')) {
    return '付款狀態由收付款紀錄自動推導，請至收付款管理新增或修改。';
  }
  // 收付款金額改由勾選的單據加總而來，這幾種狀況在正常操作下不會發生，
  // 只會在畫面開著、資料同時被別處改動時出現，因此一律引導重新整理。
  // 收款與付款共用這組錯誤碼（patch-027），訊息一律講「單據」「收付款」，不寫死出貨單。
  if (raw.includes('ALLOCATION_EXCEEDS_PAYMENT')) {
    return '收付款金額與所選單據的總額不符，請重新整理後再試。';
  }
  if (raw.includes('ALLOCATION_EXCEEDS_ORDER')) {
    return '所選單據的未結金額已變動，可能已被其他收付款沖過，請重新整理後再試。';
  }
  if (raw.includes('ALLOCATION_PARTNER_MISMATCH')) {
    return '所選單據不屬於這個往來對象，請重新整理後再試。';
  }
  if (raw.includes('ALLOCATION_DIRECTION_MISMATCH')) {
    return '客戶只能沖出貨單、供應商只能沖進貨單。';
  }
  if (raw.includes('ALLOCATION_TARGET_INVALID')) {
    return '只能選擇已確認的出貨單或進貨單。';
  }
  if (raw.includes('ORDER_HAS_ALLOCATIONS')) {
    return '此單據已有收付款紀錄，請先至收付款管理刪除對應的紀錄後再作廢。';
  }
  if (raw.includes('ORDER_TOTAL_BELOW_ALLOCATED')) {
    return '單據金額低於已收付金額，請先至收付款管理刪除對應的紀錄。';
  }
  if (raw.includes('PAYMENT_PARTNER_INVALID')) return '找不到此往來對象，請重新整理後再試。';
  if (raw.includes('PAYMENT_PARTNER_REQUIRED')) return '請選擇往來對象。';
  if (raw.includes('PAYMENT_AMOUNT_INVALID')) return '收付款金額必須大於 0。';
  if (raw.includes('PAYMENT_METHOD_INVALID')) return '收付款方式不正確。';
  if (raw.includes('PAYMENT_NOT_FOUND')) return '找不到此收付款紀錄，可能已被刪除。';
  if (raw.includes('ALLOCATION_AMOUNT_INVALID')) return '單據的沖帳金額必須大於 0。';

  if (/duplicate key value/i.test(raw)) {
    const matched = Object.keys(UNIQUE_FIELD_LABELS).find(key => raw.includes(key));
    if (matched) return `${UNIQUE_FIELD_LABELS[matched]}已存在，請改用其他值。`;
    return '資料重複，請檢查輸入內容是否與現有資料相同。';
  }

  if (/violates foreign key constraint/i.test(raw)) return FOREIGN_KEY_MESSAGE;
  if (/violates not-null constraint/i.test(raw)) return '有必填欄位未填寫，請檢查後再送出。';
  if (/violates check constraint/i.test(raw)) return '輸入的數值不符合限制，請檢查後再送出。';
  if (/Failed to fetch|NetworkError/i.test(raw)) return '連線失敗，請確認網路後再試一次。';

  return raw || '發生未知錯誤，請稍後再試。';
}

export function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

export function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
  }
}

export function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
  }
}

export function initSidebar() {
  const toggleBtn = document.querySelector('.sidebar-toggle');
  const menuBtn = document.querySelector('.btn-menu');
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.querySelector('.sidebar-backdrop');
  const html = document.documentElement;
  
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
    if (item.getAttribute('data-page') === currentPath) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isCollapsed = html.classList.toggle('sidebar-collapsed');
      localStorage.setItem('sidebar-collapsed', isCollapsed);
      toggleBtn.setAttribute('aria-expanded', !isCollapsed);
    });
  }

  function toggleMobileSidebar() {
    const isOpen = sidebar.classList.toggle('mobile-open');
    backdrop.classList.toggle('mobile-open');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', isOpen);
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', toggleMobileSidebar);
  }

  if (backdrop) {
    backdrop.addEventListener('click', toggleMobileSidebar);
  }

  // 登入頁沒有側邊欄，跳過；其餘頁面在側邊欄底部補上使用者資訊與登出鈕。
  if (sidebar) renderAuthControls(sidebar);
}

// 登出鈕與使用者 email 的 markup 在六個頁面的側邊欄完全一致，
// 集中在這裡動態插入，而非各頁各寫一份（分頁列散落五支檔案的教訓）。
function renderAuthControls(sidebar) {
  const wrap = document.createElement('div');
  wrap.className = 'sidebar-user';
  wrap.innerHTML = `
    <span class="sidebar-user-email"></span>
    <button class="btn btn-outline sidebar-logout" type="button">登出</button>
  `;
  sidebar.insertBefore(wrap, sidebar.querySelector('.sidebar-toggle'));

  // email 來自已驗證的 JWT，用 textContent 寫入（非 innerHTML），不必跳脫。
  sb.auth.getClaims().then(({ data }) => {
    const email = data?.claims?.email || '';
    const el = wrap.querySelector('.sidebar-user-email');
    el.textContent = email;
    el.title = email;
  });

  wrap.querySelector('.sidebar-logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.replace('login.html');
  });
}

// 勿改回單純的 addEventListener('DOMContentLoaded')：打包後 chunk 較大，
// 模組解析可能晚於該事件，監聽器註冊時事件已過去，初始化整段不執行
// （實際症狀：products.html#view=low-stock 的 hash 失效）。
export function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}

// 出貨單／收款單印在中二刀複寫三聯報表紙上，一頁一張單（尺寸見 style.css 的 @page slip）。
// 每張單只印一次：三聯是複寫紙自己壓出來的，程式重複印反而會浪費一整張。
export function printSlips(slipHtmls) {
  const printArea = document.getElementById('print-area');
  printArea.innerHTML = slipHtmls
    .map(html => `<section class="print-slip">${html}</section>`)
    .join('');
  window.print();
}

const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// 列表勾選多張單一起印，一次送進連續報表紙，不必逐張開列印對話框。
// 勾選欄獨立放在最左、列印鈕放在表格上方的選取工具列（有勾選才出現），
// 不和每列的編輯／作廢擠在一起：勾選是「選這一列」，按鈕是「立刻執行」，混放容易誤點。
//
// 選取存在 Map 而非讀 DOM：換頁、改搜尋條件後表身會重繪，勾過的單仍要保留，跨頁也能一起印；
// 也因此工具列要有「清除選取」，否則得翻回每一頁逐一取消。
// 表頭第一格要放 .print-pick-all（見 orders.html），各列第一格用回傳的 checkboxCell 產生。
export function setupPrintSelection({ table, printLabel, getItem, onPrint }) {
  const tableEl = document.querySelector(table);
  const tbody = tableEl.tBodies[0];
  const selectAll = tableEl.querySelector('.print-pick-all input');
  const selected = new Map();

  const bar = document.createElement('div');
  bar.className = 'selection-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <span class="selection-bar-count"></span>
    <div class="selection-bar-actions">
      <button type="button" class="btn btn-outline" id="btn-clear-selection">清除選取</button>
      <button type="button" class="btn btn-primary" id="btn-print-selected">${escapeHtml(printLabel)}</button>
    </div>`;
  tableEl.closest('.table-responsive').before(bar);
  const countEl = bar.querySelector('.selection-bar-count');

  const pageInputs = () => [...tbody.querySelectorAll('.print-pick input')];

  const toggle = (input, on) => {
    input.checked = on;
    const id = input.getAttribute('data-id');
    const item = on && getItem(id);
    if (item) selected.set(id, item);
    else selected.delete(id);
  };

  const sync = () => {
    const n = selected.size;
    bar.hidden = n === 0;
    // 一頁中二刀放一張單，放紙前就知道要準備幾張（明細過長接到下一頁時會再多用）
    countEl.textContent = `已選 ${n} 張，需中二刀 ${n} 張`;

    const inputs = pageInputs();
    const checked = inputs.filter(i => i.checked).length;
    selectAll.disabled = inputs.length === 0;
    selectAll.checked = inputs.length > 0 && checked === inputs.length;
    selectAll.indeterminate = checked > 0 && checked < inputs.length;
  };

  tbody.addEventListener('change', (e) => {
    const input = e.target.closest('.print-pick input');
    if (!input) return;
    toggle(input, input.checked);
    sync();
  });

  // 用 click 而非 change：半選（indeterminate）狀態下要能一次全選（同對帳單的全選）
  selectAll.addEventListener('click', () => {
    const inputs = pageInputs();
    const on = !inputs.every(i => i.checked);
    inputs.forEach(i => toggle(i, on));
    sync();
  });

  const clearSelection = () => {
    selected.clear();
    pageInputs().forEach(i => { i.checked = false; });
    sync();
  };

  bar.querySelector('#btn-clear-selection').addEventListener('click', clearSelection);

  // 印完就清除，下一批才不會混進已經印過的單。window.print() 會等列印對話框關閉才返回，
  // 所以這裡對話框已經關了——但瀏覽器分不出是按了列印還是取消，取消也會清除。
  // onPrint 回傳 false（載入資料失敗、根本沒開列印）時保留選取，讓使用者直接重試。
  bindSubmitOnce('btn-print-selected', async () => {
    if (await onPrint([...selected.values()])) clearSelection();
  });

  // 表身由各頁 innerHTML 重繪（分頁、搜尋），重繪後表頭全選要跟著本頁的勾選狀態更新
  new MutationObserver(sync).observe(tbody, { childList: true });
  sync();

  return {
    // 同一張表切換到不可列印的檢視（收付款頁的付款分頁）時，殘留的選取不能帶過去
    clear: clearSelection,
    // 不能列印的列（進貨、作廢…）也要輸出空格，欄位才對得齊
    checkboxCell: (id, selectable = true) => selectable
      ? `<td class="col-pick">
          <label class="checkbox print-pick">
            <input type="checkbox" data-id="${escapeHtml(id)}" aria-label="選取列印" ${selected.has(id) ? 'checked' : ''}>
            <span class="checkbox-box">${CHECK_ICON}</span>
          </label>
        </td>`
      : '<td class="col-pick"></td>'
  };
}

// Setup modal close buttons
onReady(() => {
  initSidebar();
  
  document.querySelectorAll('.close-btn, [data-dismiss="modal"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-overlay');
      if (modal) {
        modal.classList.remove('active');
      }
    });
  });

  // 游標停在 focus 中的 input[type=number] 上捲頁面，瀏覽器會把滾輪當成上下箭頭
  // 而改掉數值；金額欄位又以整數呈現（formatCurrency 不顯示小數），改掉了也看不出來。
  // 因此捲動時直接讓它失焦。用 blur 而非 preventDefault：後者會連頁面都捲不動。
  document.addEventListener('wheel', () => {
    const el = document.activeElement;
    if (el?.type === 'number') el.blur();
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openedModal = document.querySelector('.modal-overlay.active');
      if (openedModal) {
        openedModal.classList.remove('active');
      }
    }
  });
});
