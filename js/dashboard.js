import {
  COST_PAGE_SIZE,
  fetchCostPage,
  fetchCostTotals,
  fetchPeriodSummary
} from './inventory-cost.js';
import { showToast, onReady, renderPagination } from './ui.js';
import { formatCurrency, dateRange, totalPages, escapeHtml, round2 } from './utils.js';

const dateFrom = document.getElementById('cost-date-from');
const dateTo = document.getElementById('cost-date-to');
const btnSearch = document.getElementById('btn-cost-search');
const btnPrevPage = document.getElementById('btn-cost-prev');
const btnNextPage = document.getElementById('btn-cost-next');

let costPage = 1;
let costTotal = 0;

async function loadMonthlySummary(range) {
  const { revenue, expense, cost } = await fetchPeriodSummary(range.from, range.to);
  const profit = round2(revenue - cost);

  document.getElementById('stat-month-revenue').textContent = formatCurrency(revenue);
  document.getElementById('stat-month-expense').textContent = formatCurrency(expense);
  document.getElementById('stat-month-cost').textContent = formatCurrency(cost);
  
  const profitEl = document.getElementById('stat-month-profit');
  profitEl.textContent = formatCurrency(profit);
  profitEl.classList.toggle('text-danger', profit < 0);
  profitEl.classList.toggle('text-success', profit >= 0);
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
          <a href="products.html#search=${encodeURIComponent(row.sku)}" class="product-link">${escapeHtml(row.name)}</a>
          <div class="text-muted cost-sku">${escapeHtml(row.sku)}</div>
        </td>
        <td>${row.purchase_qty} ${escapeHtml(row.unit || '')}</td>
        <td class="num">${formatCurrency(row.purchase_amount)}</td>
        <td>${row.sale_qty} ${escapeHtml(row.unit || '')}</td>
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
  renderPagination({
    page: costPage,
    total: costTotal,
    pageSize: COST_PAGE_SIZE,
    unit: '項商品',
    pageInfoId: 'cost-page-info',
    prevId: 'btn-cost-prev',
    nextId: 'btn-cost-next'
  });
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
      fetchCostPage({ from, to, page: costPage }),
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
  const range = dateRange('currentMonth');
  dateFrom.value = range.from;
  dateTo.value = range.to;

  try {
    await Promise.all([
      loadMonthlySummary(range),
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

  btnPrevPage.addEventListener('click', () => {
    if (costPage > 1) {
      costPage--;
      loadCostPage();
    }
  });

  btnNextPage.addEventListener('click', () => {
    if (costPage < totalPages(costTotal, COST_PAGE_SIZE)) {
      costPage++;
      loadCostPage();
    }
  });
});
