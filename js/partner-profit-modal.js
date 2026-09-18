// ============================================================
// 客戶毛利分析 modal：總覽（點排行圖或清單列）與往來對象（點客戶列）共用同一份。
//
// markup 由本模組動態注入，不寫進兩支 HTML——分頁列曾經同一段散落五支檔案、
// toDateInputValue 曾經有兩份實作，都是「複製一份比較快」留下的帳（見 CLAUDE.md）。
// 側邊欄登出鈕也是這樣處理的（ui.js 的 renderAuthControls）。
// ============================================================
import { openModal, renderPagination, showToast, toErrorMessage } from './ui.js';
import { formatCurrency, escapeHtml, dateRange, totalPages } from './utils.js';
import {
  PROFIT_PAGE_SIZE,
  fetchPartnerProfitDetail,
  fetchPartnerProfitProducts,
  fetchPartnerOutstanding
} from './partner-profit.js';

const MODAL_ID = 'partner-profit-modal';

let partnerId = null;
let partnerName = '';
let page = 1;
let total = 0;

// 每次查詢取一個遞增序號，只有最後發出的那次可以寫進畫面。
// 沒有這道閘門時，連開客戶 A、B 若 A 的回應較慢，會蓋掉 B 的內容，
// 變成標題是 B、數字是 A。改日期與翻頁也有同樣的競態。
let requestSeq = 0;

function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = MODAL_ID;
  modal.innerHTML = `
    <div class="modal-content modal-content--wide">
      <div class="modal-header">
        <h3 id="partner-profit-title">客戶毛利分析</h3>
        <button class="close-btn" type="button" aria-label="關閉">&times;</button>
      </div>
      <div class="modal-body">
        <div class="date-controls mb-4">
          <input type="date" class="profit-date-from">
          <span>至</span>
          <input type="date" class="profit-date-to">
          <button class="btn btn-outline btn-quick-date" data-range="thisMonth" type="button">本月</button>
          <button class="btn btn-outline btn-quick-date" data-range="lastMonth" type="button">上月</button>
          <button class="btn btn-outline btn-quick-date" data-range="last30Days" type="button">近30天</button>
          <button class="btn btn-outline btn-quick-date" data-range="all" type="button">累計</button>
        </div>
        <div class="partner-profit-content">載入中...</div>
        <!-- 分頁列放在 partner-profit-content 之外：該區塊每次查詢都會整個重繪，
             按鈕若放在裡面，綁定的事件監聽器會跟著舊 DOM 一起被丟掉。 -->
        <div class="pagination" id="partner-profit-pagination" hidden>
          <button class="btn btn-outline" id="btn-partner-profit-prev" disabled type="button">上一頁</button>
          <span id="partner-profit-page-info">第 1 頁</span>
          <button class="btn btn-outline" id="btn-partner-profit-next" disabled type="button">下一頁</button>
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

  const fromInput = modal.querySelector('.profit-date-from');
  const toInput = modal.querySelector('.profit-date-to');

  // 換日期區間等於換一組資料，頁碼必須歸 1，
  // 否則停在第 3 頁時改區間會落在新結果的空白頁。
  const reload = () => {
    if (!partnerId) return;
    page = 1;
    total = 0;
    load();
  };

  fromInput.addEventListener('change', reload);
  toInput.addEventListener('change', reload);

  modal.querySelectorAll('.btn-quick-date').forEach(btn => {
    btn.addEventListener('click', () => {
      const { from, to } = dateRange(btn.dataset.range);
      fromInput.value = from;
      toInput.value = to;
      reload();
    });
  });

  // 夾在合法範圍內，不能只靠按鈕的 disabled：請求還在飛的時候連點兩次下一頁，
  // 第二次點擊時按鈕尚未依新結果更新，頁碼就會衝過最後一頁而顯示空白表格。
  const goToPage = (delta) => {
    if (!partnerId) return;

    const lastPage = totalPages(total, PROFIT_PAGE_SIZE);
    const next = Math.min(Math.max(page + delta, 1), lastPage);
    if (next === page) return;

    page = next;
    load();
  };

  document.getElementById('btn-partner-profit-prev').addEventListener('click', () => goToPage(-1));
  document.getElementById('btn-partner-profit-next').addEventListener('click', () => goToPage(1));

  return modal;
}

function renderCards({ detail, outstanding }) {
  const saleAmount = detail?.saleAmount || 0;
  const cost = detail?.cost || 0;
  const profit = detail?.profit || 0;
  const orderCount = detail?.orderCount || 0;
  const noCostQty = detail?.noCostQty || 0;

  // 分母為 0 就沒有毛利率可談（退貨沖銷後淨額歸零也會落在這裡），顯示 -- 而非 0%。
  const marginText = saleAmount > 0 ? `${((profit / saleAmount) * 100).toFixed(1)}%` : '--';
  const marginClass = profit < 0 ? 'negative' : '';

  const costNote = noCostQty > 0
    ? `⚠ 其中 ${noCostQty} 件成本未知，毛利偏高`
    : `Σ 出貨成本快照`;

  return `
    <div class="metric-cards">
      <div class="metric-card">
        <div class="metric-card-title">期間出貨收益</div>
        <div class="metric-card-value">${detail ? formatCurrency(saleAmount) : '--'}</div>
        <div class="metric-card-subtitle">出 ${orderCount} 張單，未稅、已扣折讓</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-title">期間出貨成本</div>
        <div class="metric-card-value">${detail ? formatCurrency(cost) : '--'}</div>
        <div class="metric-card-subtitle">${costNote}</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-title">毛利</div>
        <div class="metric-card-value ${marginClass}">${detail ? formatCurrency(profit) : '--'}</div>
        <div class="metric-card-subtitle">毛利率 ${marginText}</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-title">目前未收餘額</div>
        <div class="metric-card-value">${formatCurrency(outstanding)}</div>
        <div class="metric-card-subtitle">※ 全期間累計，非上方區間</div>
      </div>
    </div>
  `;
}

function renderProducts(rows) {
  if (rows.length === 0) {
    return '<div class="empty-state">此區間沒有出貨紀錄</div>';
  }

  const body = rows.map(row => {
    const margin = row.saleAmount > 0
      ? `${((row.profit / row.saleAmount) * 100).toFixed(1)}%`
      : '--';

    return `
      <tr>
        <td>
          ${escapeHtml(row.name)}
          <div class="text-muted cost-sku">${escapeHtml(row.sku || '')}</div>
        </td>
        <td class="num">${row.saleQty} ${escapeHtml(row.unit || '')}</td>
        <td class="num">${formatCurrency(row.saleAmount)}</td>
        <td class="num">${formatCurrency(row.cost)}</td>
        <td class="num ${row.profit < 0 ? 'text-danger' : 'text-success'}">${formatCurrency(row.profit)}</td>
        <td class="num">${margin}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="records-table">
      <thead>
        <tr>
          <th>商品</th>
          <th>數量</th>
          <th>出貨額</th>
          <th>出貨成本</th>
          <th>毛利</th>
          <th>毛利率</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

async function load() {
  const modal = ensureModal();
  const content = modal.querySelector('.partner-profit-content');
  const from = modal.querySelector('.profit-date-from').value;
  const to = modal.querySelector('.profit-date-to').value;

  content.innerHTML = '載入中...';

  const requestId = ++requestSeq;
  const isStale = () => requestId !== requestSeq;

  try {
    // 三支各自獨立：彙總掃全區間只回一列、商品組成只取當頁、餘額是另一套口徑的既有 RPC。
    const [detail, products, outstanding] = await Promise.all([
      fetchPartnerProfitDetail(partnerId, from, to),
      fetchPartnerProfitProducts({ partnerId, from, to, page }),
      fetchPartnerOutstanding(partnerId)
    ]);

    if (isStale()) return;

    total = products.total;

    content.innerHTML = `
      ${renderCards({ detail, outstanding })}
      <h5 class="partner-profit-subtitle">商品組成</h5>
      ${renderProducts(products.rows)}
    `;

    document.getElementById('partner-profit-pagination').hidden = products.total === 0;
    renderPagination({
      page,
      total: products.total,
      pageSize: PROFIT_PAGE_SIZE,
      unit: '項商品',
      pageInfoId: 'partner-profit-page-info',
      prevId: 'btn-partner-profit-prev',
      nextId: 'btn-partner-profit-next'
    });
  } catch (error) {
    console.error('Error loading partner profit:', error);
    if (isStale()) return;

    content.innerHTML = `<div class="text-danger">載入失敗：${escapeHtml(toErrorMessage(error))}</div>`;
    document.getElementById('partner-profit-pagination').hidden = true;
    showToast('載入客戶毛利失敗：' + toErrorMessage(error), 'error');
  }
}

/**
 * 開啟客戶毛利分析 modal。
 * @param {string} id 客戶 id
 * @param {string} name 客戶名稱（僅用於標題）
 * @param {{from?: string, to?: string}} range 初始區間；未給則用本月（月初到今天）
 */
export function openPartnerProfitModal(id, name, range = {}) {
  const modal = ensureModal();

  partnerId = id;
  partnerName = name || '';
  page = 1;
  total = 0;

  // 標題用 textContent 寫入，不走 innerHTML——客戶名稱是使用者自由輸入的欄位。
  document.getElementById('partner-profit-title').textContent =
    `客戶毛利分析 - ${partnerName}`;

  const fallback = dateRange('thisMonth');
  modal.querySelector('.profit-date-from').value = range.from ?? fallback.from;
  modal.querySelector('.profit-date-to').value = range.to ?? fallback.to;

  openModal(MODAL_ID);
  load();
}
