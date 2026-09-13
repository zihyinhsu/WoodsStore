// Shared UI Helpers
//
// 這裡只放會操作 DOM 或瀏覽器狀態的共用元件。
// 純函式（格式化、日期換算、數值處理）請放 utils.js。
import { totalPages } from './utils.js';

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
  payments_payment_no_key: '收款單號',
  orders_order_no_key: '單號'
};

const FOREIGN_KEY_MESSAGE = '此筆資料已被其他單據使用，無法刪除或修改。';

export function toErrorMessage(error) {
  const raw = error?.message || '';

  if (raw.includes('ORDER_NOT_EDITABLE')) {
    return '此單據狀態已變更（可能已被確認或作廢），無法編輯。請重新整理後再試。';
  }
  if (raw.includes('ORDER_NOT_FOUND')) return '找不到此單據，可能已被刪除。';

  if (raw.includes('PAYMENT_STATUS_READONLY')) {
    return '付款狀態由收款紀錄自動推導，請至收款管理新增或修改收款。';
  }
  if (raw.includes('ALLOCATION_EXCEEDS_PAYMENT')) {
    return '分配總額超過收款金額，請調整各單據的沖帳金額。';
  }
  if (raw.includes('ALLOCATION_EXCEEDS_ORDER')) {
    return '沖帳金額超過該單據的應收金額，請確認是否已有其他收款沖過同一張單。';
  }
  if (raw.includes('ALLOCATION_PARTNER_MISMATCH')) {
    return '收款客戶與單據客戶不一致，無法沖帳。';
  }
  if (raw.includes('ALLOCATION_TARGET_INVALID')) {
    return '只能沖帳已確認的出貨單。';
  }
  if (raw.includes('ORDER_HAS_ALLOCATIONS')) {
    return '此單據已有收款沖帳，請先至收款管理移除相關分配後再作廢。';
  }
  if (raw.includes('ORDER_TOTAL_BELOW_ALLOCATED')) {
    return '單據金額低於已收款金額，請先調整收款分配。';
  }
  if (raw.includes('PAYMENT_PARTNER_INVALID')) return '收款對象必須是客戶。';
  if (raw.includes('PAYMENT_PARTNER_REQUIRED')) return '請選擇收款客戶。';
  if (raw.includes('PAYMENT_AMOUNT_INVALID')) return '收款金額必須大於 0。';
  if (raw.includes('PAYMENT_METHOD_INVALID')) return '收款方式不正確。';
  if (raw.includes('PAYMENT_NOT_FOUND')) return '找不到此收款紀錄，可能已被刪除。';
  if (raw.includes('ALLOCATION_AMOUNT_INVALID')) return '沖帳金額必須大於 0。';

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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openedModal = document.querySelector('.modal-overlay.active');
      if (openedModal) {
        openedModal.classList.remove('active');
      }
    }
  });
});
