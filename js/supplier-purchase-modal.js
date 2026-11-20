// ============================================================
// 供應商進貨 modal：總覽「供應商進貨」分頁點列開啟，回答「這段期間跟這家買了什麼、花了多少」。
// 外框、日期列、分頁與競態閘門由 range-modal.js 提供，這裡只負責內容。
// ============================================================
import { createRangeModal } from './range-modal.js';
import { RETURN_TYPE_BADGES } from './ui.js';
import { formatCurrency, escapeHtml, negativeClass, orderSearchLink, formatDate } from './utils.js';
import {
  SUPPLIER_PAGE_SIZE,
  fetchSupplierPurchaseDetail,
  fetchSupplierPurchaseItems,
  fetchSupplierOutstanding
} from './supplier-purchase.js';

let partnerId = null;

function renderCards({ detail, outstanding }) {
  const value = amount => (detail ? formatCurrency(amount) : '--');

  return `
    <div class="metric-cards">
      <div class="metric-card">
        <div class="metric-card-title">期間進貨</div>
        <div class="metric-card-value">${value(detail?.purchaseAmount)}</div>
        <div class="metric-card-subtitle">進 ${detail?.orderCount || 0} 張單，未稅、已扣折讓</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-title">期間進貨退出</div>
        <div class="metric-card-value ${detail?.returnAmount < 0 ? 'negative' : ''}">${value(detail?.returnAmount)}</div>
        <div class="metric-card-subtitle">退 ${detail?.returnCount || 0} 張單</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-title">期間淨進貨</div>
        <div class="metric-card-value">${value(detail?.netAmount)}</div>
        <div class="metric-card-subtitle">進貨 − 退出，與總覽進貨成本同口徑</div>
      </div>
      <div class="metric-card">
        <div class="metric-card-title">目前未付餘額</div>
        <div class="metric-card-value">${formatCurrency(outstanding)}</div>
        <div class="metric-card-subtitle">※ 全期間累計，非上方區間</div>
      </div>
    </div>
  `;
}

function renderItems(rows) {
  if (rows.length === 0) {
    return '<div class="empty-state">此區間沒有進貨紀錄</div>';
  }

  const body = rows.map(row => {
    // 退出列帶徽章：金額是負數已經是紅字，但只看顏色分不出是退貨還是資料錯。
    const badge = RETURN_TYPE_BADGES[row.type] ? ` ${RETURN_TYPE_BADGES[row.type]}` : '';

    return `
      <tr>
        <td>${formatDate(row.orderDate)}</td>
        <td>${orderSearchLink(row.orderNo, row.orderDate)}${badge}</td>
        <td>
          ${escapeHtml(row.name)}
          <div class="text-muted cost-sku">${escapeHtml(row.sku || '')}</div>
        </td>
        <td class="num ${negativeClass(row.qty)}">${row.qty} ${escapeHtml(row.unit || '')}</td>
        <td class="num">${formatCurrency(row.unitPrice)}</td>
        <td class="num ${negativeClass(row.amount)}">${formatCurrency(row.amount)}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="records-table">
      <thead>
        <tr>
          <th>日期</th>
          <th>單號</th>
          <th>商品</th>
          <th>數量</th>
          <th>單價</th>
          <th>金額</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

// 三支各自獨立：彙總掃全區間只回一列、明細只取當頁、餘額是另一套口徑的既有 RPC。
async function render({ from, to, page }) {
  const [detail, items, outstanding] = await Promise.all([
    fetchSupplierPurchaseDetail(partnerId, from, to),
    fetchSupplierPurchaseItems({ partnerId, from, to, page }),
    fetchSupplierOutstanding(partnerId)
  ]);

  return {
    total: items.total,
    html: `
      ${renderCards({ detail, outstanding })}
      <h5 class="partner-profit-subtitle">進貨明細</h5>
      ${renderItems(items.rows)}
      <p class="text-muted cost-sku">金額已扣分攤的整單折讓、未加稅；整單有折讓時逐列進位，加總可能與上方差一兩分。</p>
    `
  };
}

const modal = createRangeModal({
  id: 'supplier-purchase',
  pageSize: SUPPLIER_PAGE_SIZE,
  unit: '筆明細',
  errorLabel: '載入供應商進貨失敗',
  render
});

/**
 * 開啟供應商進貨 modal。
 * @param {string} id 供應商 id
 * @param {string} name 供應商名稱（僅用於標題）
 * @param {{from?: string, to?: string}} range 初始區間；未給則用本月（月初到今天）
 */
export function openSupplierPurchaseModal(id, name, range = {}) {
  partnerId = id;
  modal.open(`供應商進貨 - ${name || ''}`, range);
}
