// ============================================================
// 純工具函式：不碰 DOM、不依賴頁面狀態，可單獨測試。
// 會操作 DOM 的共用元件（toast / modal / sidebar / 分頁渲染）請放 ui.js。
// ============================================================

export const PAGE_SIZE = 10;

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

// 日期輸入框用的 YYYY-MM-DD。
// 不能用 toISOString()：那會先轉成 UTC，台北時間當天 08:00 前會變成前一天。
export function toDateInputValue(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// 各頁快捷日期區間共用的換算，一律回傳 YYYY-MM-DD 字串（'all' 回傳空字串代表不限）。
// 集中在這裡是因為同一組月份／週次算法原本散落在單據頁與商品頁，改一邊容易漏另一邊。
export function dateRange(preset, today = new Date()) {
  const year = today.getFullYear();
  const month = today.getMonth();

  switch (preset) {
    case 'today':
      return { from: toDateInputValue(today), to: toDateInputValue(today) };

    case 'thisWeek': {
      // 以週一為起始。getDay() 的週日是 0，要往回推 6 天而不是往前 1 天。
      const day = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - day + (day === 0 ? -6 : 1));
      return { from: toDateInputValue(monday), to: toDateInputValue(today) };
    }

    // thisMonth 是「月初到今天」，currentMonth 是「整個月份」，兩者用途不同勿混用：
    // 前者給查詢用的預設區間，後者給對帳單與總覽的月報表。
    case 'thisMonth':
      return { from: toDateInputValue(new Date(year, month, 1)), to: toDateInputValue(today) };

    case 'currentMonth':
      return {
        from: toDateInputValue(new Date(year, month, 1)),
        to: toDateInputValue(new Date(year, month + 1, 0))
      };

    case 'lastMonth':
      return {
        from: toDateInputValue(new Date(year, month - 1, 1)),
        to: toDateInputValue(new Date(year, month, 0))
      };

    case 'last30Days': {
      const start = new Date(today);
      start.setDate(today.getDate() - 30);
      return { from: toDateInputValue(start), to: toDateInputValue(today) };
    }

    case 'all':
      return { from: '', to: '' };

    default:
      throw new Error(`Unknown date range preset: ${preset}`);
  }
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

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// 金額運算用。浮點數相加會出現 0.1 + 0.2 這類尾數，
// 沖帳金額比對「是否剛好等於收款金額」時會誤判，因此每步都收斂到分。
export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

export function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const bucket = map.get(row[key]);
    if (bucket) bucket.push(row);
    else map.set(row[key], [row]);
  }
  return map;
}

// 沒有資料時仍回傳 1，避免顯示「第 1 / 0 頁」。
export function totalPages(total, pageSize = PAGE_SIZE) {
  return Math.ceil(total / pageSize) || 1;
}
