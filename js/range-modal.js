// ============================================================
// 「單一往來對象 × 自訂區間」分析 modal 的共用骨架：客戶毛利、供應商進貨共用。
//
// 兩個 modal 的外框、日期列、快捷區間、分頁、競態閘門完全一樣，只差中間的內容。
// 這段原本只寫在 partner-profit-modal.js 一份，做供應商進貨時抽出來，
// 而不是複製一份再改——分頁列曾經同一段散落五支檔案（見 CLAUDE.md）。
//
// markup 由本模組動態注入，不寫進各頁 HTML：同一個 modal 會在總覽與往來對象兩頁出現。
// ============================================================
import { openModal, renderPagination, showToast, toErrorMessage } from './ui.js';
import { escapeHtml, dateRange, totalPages, clamp } from './utils.js';

/**
 * @param {object} options
 * @param {string} options.id         id 前綴；modal 為 `${id}-modal`，標題、分頁列等子元素也以它為前綴
 * @param {number} options.pageSize   下方明細的每頁筆數
 * @param {string} options.unit       分頁列的單位文案（「項商品」「筆明細」）
 * @param {string} options.errorLabel 載入失敗 toast 的前綴（「載入客戶毛利失敗」）
 * @param {(query: {from: string, to: string, page: number}) => Promise<{html: string, total: number}>} options.render
 *        依區間與頁碼取資料、回傳要放進內容區的 HTML 與明細總筆數。HTML 裡的使用者輸入須自行跳脫。
 * @returns {{open: (title: string, range?: {from?: string, to?: string}) => void}}
 */
export function createRangeModal({ id, pageSize, unit, errorLabel, render }) {
  const modalId = `${id}-modal`;

  let opened = false;
  let page = 1;
  let total = 0;

  // 每次查詢取一個遞增序號，只有最後發出的那次可以寫進畫面。
  // 沒有這道閘門時，連開 A、B 若 A 的回應較慢，會蓋掉 B 的內容，
  // 變成標題是 B、數字是 A。改日期與翻頁也有同樣的競態。
  let requestSeq = 0;

  function ensureModal() {
    let modal = document.getElementById(modalId);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = modalId;
    modal.innerHTML = `
      <div class="modal-content modal-content--wide">
        <div class="modal-header">
          <h3 id="${id}-title"></h3>
          <button class="close-btn" type="button" aria-label="關閉">&times;</button>
        </div>
        <div class="modal-body">
          <div class="date-controls mb-4">
            <input type="date" class="range-date-from">
            <span>至</span>
            <input type="date" class="range-date-to">
            <button class="btn btn-outline btn-quick-date" data-range="thisMonth" type="button">本月</button>
            <button class="btn btn-outline btn-quick-date" data-range="lastMonth" type="button">上月</button>
            <button class="btn btn-outline btn-quick-date" data-range="last30Days" type="button">近30天</button>
            <button class="btn btn-outline btn-quick-date" data-range="all" type="button">累計</button>
          </div>
          <div class="range-modal-content">載入中...</div>
          <!-- 分頁列放在 range-modal-content 之外：該區塊每次查詢都會整個重繪，
               按鈕若放在裡面，綁定的事件監聽器會跟著舊 DOM 一起被丟掉。 -->
          <div class="pagination" id="${id}-pagination" hidden>
            <button class="btn btn-outline" id="btn-${id}-prev" disabled type="button">上一頁</button>
            <span id="${id}-page-info">第 1 頁</span>
            <button class="btn btn-outline" id="btn-${id}-next" disabled type="button">下一頁</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // ui.js 的 .close-btn 綁定在 onReady 就跑完了，這個 modal 是之後才注入的，
    // 不會被那一輪掃到，必須自己綁。Escape 鍵那段是 document 層的委派，不受影響。
    modal.querySelector('.close-btn').addEventListener('click', () => {
      modal.classList.remove('active');
    });

    const fromInput = modal.querySelector('.range-date-from');
    const toInput = modal.querySelector('.range-date-to');

    // 換日期區間等於換一組資料，頁碼必須歸 1，
    // 否則停在第 3 頁時改區間會落在新結果的空白頁。
    const reload = () => {
      if (!opened) return;
      page = 1;
      total = 0;
      load();
    };

    fromInput.addEventListener('change', reload);
    toInput.addEventListener('change', reload);

    modal.querySelectorAll('.btn-quick-date').forEach(btn => {
      btn.addEventListener('click', () => {
        const range = dateRange(btn.dataset.range);
        fromInput.value = range.from;
        toInput.value = range.to;
        reload();
      });
    });

    // 夾在合法範圍內，不能只靠按鈕的 disabled：請求還在飛的時候連點兩次下一頁，
    // 第二次點擊時按鈕尚未依新結果更新，頁碼就會衝過最後一頁而顯示空白表格。
    const goToPage = (delta) => {
      if (!opened) return;

      const next = clamp(page + delta, 1, totalPages(total, pageSize));
      if (next === page) return;

      page = next;
      load();
    };

    document.getElementById(`btn-${id}-prev`).addEventListener('click', () => goToPage(-1));
    document.getElementById(`btn-${id}-next`).addEventListener('click', () => goToPage(1));

    return modal;
  }

  async function load() {
    const modal = ensureModal();
    const content = modal.querySelector('.range-modal-content');
    const pagination = document.getElementById(`${id}-pagination`);
    const from = modal.querySelector('.range-date-from').value;
    const to = modal.querySelector('.range-date-to').value;

    content.innerHTML = '載入中...';

    const requestId = ++requestSeq;
    const isStale = () => requestId !== requestSeq;

    try {
      const result = await render({ from, to, page });
      if (isStale()) return;

      total = result.total;
      content.innerHTML = result.html;

      pagination.hidden = total === 0;
      renderPagination({
        page,
        total,
        pageSize,
        unit,
        pageInfoId: `${id}-page-info`,
        prevId: `btn-${id}-prev`,
        nextId: `btn-${id}-next`
      });
    } catch (error) {
      console.error(`${errorLabel}:`, error);
      if (isStale()) return;

      content.innerHTML = `<div class="text-danger">載入失敗：${escapeHtml(toErrorMessage(error))}</div>`;
      pagination.hidden = true;
      showToast(`${errorLabel}：` + toErrorMessage(error), 'error');
    }
  }

  return {
    /**
     * @param {string} title 標題；以 textContent 寫入，往來對象名稱是使用者自由輸入的欄位
     * @param {{from?: string, to?: string}} range 初始區間；未給則用本月（月初到今天）
     */
    open(title, range = {}) {
      const modal = ensureModal();

      opened = true;
      page = 1;
      total = 0;

      document.getElementById(`${id}-title`).textContent = title;

      const fallback = dateRange('thisMonth');
      modal.querySelector('.range-date-from').value = range.from ?? fallback.from;
      modal.querySelector('.range-date-to').value = range.to ?? fallback.to;

      openModal(modalId);
      load();
    }
  };
}
