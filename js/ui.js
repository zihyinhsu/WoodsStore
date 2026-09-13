// Shared UI Helpers

export function formatCurrency(amount) {
  return new Intl.NumberFormat('zh-TW', {
    style: 'currency',
    currency: 'TWD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount || 0);
}

export function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');
}

export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
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

// Setup modal close buttons
document.addEventListener('DOMContentLoaded', () => {
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
