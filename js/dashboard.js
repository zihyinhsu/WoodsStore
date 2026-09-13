import { sb } from './supabase.js';
import {
  COST_PAGE_SIZE,
  fetchCostPage,
  fetchCostTotals,
  fetchPeriodSummary
} from './inventory-cost.js';
import { formatCurrency, showToast, toDateInputValue, onReady } from './ui.js';

const dateFrom = document.getElementById('cost-date-from');
const dateTo = document.getElementById('cost-date-to');
const btnSearch = document.getElementById('btn-cost-search');
const movementOnlyToggle = document.getElementById('cost-movement-only');
const btnPrevPage = document.getElementById('btn-cost-prev');
const btnNextPage = document.getElementById('btn-cost-next');
const pageInfo = document.getElementById('cost-page-info');

let costPage = 1;
let costTotal = 0;

function monthRange(today = new Date()) {
  return {
    from: toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)),
    to: toDateInputValue(new Date(today.getFullYear(), today.getMonth() + 1, 0))
  };
}

async function loadMonthlySummary(range) {
  const { revenue, expense, cost } = await fetchPeriodSummary(range.from, range.to);

  document.getElementById('stat-month-revenue').textContent = formatCurrency(revenue);
  document.getElementById('stat-month-expense').textContent = formatCurrency(expense);
  document.getElementById('stat-month-cost').textContent = formatCurrency(cost);
}

async function loadStockStats() {
  const [totalResult, lowStockResult] = await Promise.all([
    sb.from('products').select('*', { count: 'exact', head: true }).eq('is_active', true),
    sb.from('low_stock_view').select('*', { count: 'exact', head: true }).eq('is_active', true)
  ]);

  if (totalResult.error) throw totalResult.error;
  if (lowStockResult.error) throw lowStockResult.error;

  document.getElementById('stat-total-products').textContent = totalResult.count || 0;
  document.getElementById('stat-low-stock').textContent = lowStockResult.count || 0;
}

function renderCostTable(rows) {
  const tbody = document.querySelector('#cost-table tbody');

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">此期間沒有進出貨紀錄</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const profit = Number(row.estimated_profit);
    return `
      <tr>
        <td>
          <a href="products.html#search=${encodeURIComponent(row.sku)}" class="product-link">${row.name}</a>
          <div class="text-muted cost-sku">${row.sku}</div>
        </td>
        <td>${row.purchase_qty} ${row.unit || ''}</td>
        <td class="num">${formatCurrency(row.purchase_amount)}</td>
        <td>${row.sale_qty} ${row.unit || ''}</td>
        <td class="num">${formatCurrency(row.sale_amount)}</td>
        <td class="num">${formatCurrency(row.estimated_cost)}</td>
        <td class="num ${profit < 0 ? 'text-danger' : 'text-success'}">${formatCurrency(profit)}</td>
      </tr>
    `;
  }).join('');
}

function renderCostTotals(totals) {
  document.getElementById('cost-total-purchase').textContent = formatCurrency(totals.purchaseAmount);
  document.getElementById('cost-total-sale').textContent = formatCurrency(totals.saleAmount);
  document.getElementById('cost-total-cost').textContent = formatCurrency(totals.estimatedCost);
  document.getElementById('cost-total-profit').textContent = formatCurrency(totals.estimatedProfit);
  document.getElementById('cost-totals').hidden = false;
}

function updateCostPagination() {
  const totalPages = Math.ceil(costTotal / COST_PAGE_SIZE) || 1;
  pageInfo.textContent = `第 ${costPage} / ${totalPages} 頁 (共 ${costTotal} 項商品)`;
  btnPrevPage.disabled = costPage <= 1;
  btnNextPage.disabled = costPage >= totalPages;
}

async function loadCostPage() {
  const from = dateFrom.value;
  const to = dateTo.value;

  if (!from || !to) {
    showToast('請選擇日期區間', 'error');
    return;
  }
  if (from > to) {
    showToast('開始日期不可晚於結束日期', 'error');
    return;
  }

  btnSearch.disabled = true;
  try {
    const [{ rows, total }, totals] = await Promise.all([
      fetchCostPage({ from, to, page: costPage, movementOnly: movementOnlyToggle.checked }),
      fetchCostTotals(from, to)
    ]);

    costTotal = total;
    renderCostTable(rows);
    renderCostTotals(totals);
    updateCostPagination();
  } catch (error) {
    console.error('Error loading cost analysis:', error);
    showToast('載入成本分析失敗: ' + error.message, 'error');
  } finally {
    btnSearch.disabled = false;
  }
}

function resetToFirstPageAndLoad() {
  costPage = 1;
  loadCostPage();
}

async function loadDashboard() {
  const range = monthRange();
  dateFrom.value = range.from;
  dateTo.value = range.to;

  try {
    await Promise.all([
      loadMonthlySummary(range),
      loadStockStats(),
      loadCostPage()
    ]);
  } catch (error) {
    console.error('Dashboard error:', error);
    showToast('載入總覽資料失敗: ' + error.message, 'error');
  }
}

onReady(() => {
  loadDashboard();

  btnSearch.addEventListener('click', resetToFirstPageAndLoad);
  movementOnlyToggle.addEventListener('change', resetToFirstPageAndLoad);

  btnPrevPage.addEventListener('click', () => {
    if (costPage > 1) {
      costPage--;
      loadCostPage();
    }
  });

  btnNextPage.addEventListener('click', () => {
    if (costPage < Math.ceil(costTotal / COST_PAGE_SIZE)) {
      costPage++;
      loadCostPage();
    }
  });
});
