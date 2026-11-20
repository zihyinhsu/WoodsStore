// ============================================================
// 客戶毛利分析 modal：總覽（點排行圖或清單列）與往來對象（點客戶列）共用同一份。
// 外框、日期列、分頁與競態閘門由 range-modal.js 提供，這裡只負責內容。
// ============================================================
import { createRangeModal } from './range-modal.js';
import { formatCurrency, escapeHtml } from './utils.js';
import {
  PROFIT_PAGE_SIZE,
  fetchPartnerProfitDetail,
  fetchPartnerProfitProducts,
  fetchPartnerOutstanding
} from './partner-profit.js';

let partnerId = null;

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

// 三支各自獨立：彙總掃全區間只回一列、商品組成只取當頁、餘額是另一套口徑的既有 RPC。
async function render({ from, to, page }) {
  const [detail, products, outstanding] = await Promise.all([
    fetchPartnerProfitDetail(partnerId, from, to),
    fetchPartnerProfitProducts({ partnerId, from, to, page }),
    fetchPartnerOutstanding(partnerId)
  ]);

  return {
    total: products.total,
    html: `
      ${renderCards({ detail, outstanding })}
      <h5 class="partner-profit-subtitle">商品組成</h5>
      ${renderProducts(products.rows)}
    `
  };
}

const modal = createRangeModal({
  id: 'partner-profit',
  pageSize: PROFIT_PAGE_SIZE,
  unit: '項商品',
  errorLabel: '載入客戶毛利失敗',
  render
});

/**
 * 開啟客戶毛利分析 modal。
 * @param {string} id 客戶 id
 * @param {string} name 客戶名稱（僅用於標題）
 * @param {{from?: string, to?: string}} range 初始區間；未給則用本月（月初到今天）
 */
export function openPartnerProfitModal(id, name, range = {}) {
  partnerId = id;
  modal.open(`客戶毛利分析 - ${name || ''}`, range);
}
