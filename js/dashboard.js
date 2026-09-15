import {
  COST_PAGE_SIZE,
  fetchCostPage,
  fetchCostTotals,
  fetchCostTrend,
  fetchCostRanking,
  fetchPeriodSummary
} from './inventory-cost.js';
import { showToast, renderPagination } from './ui.js';
import { requireAuth } from './auth.js';
import { formatCurrency, dateRange, totalPages, escapeHtml, round2 } from './utils.js';

const dateFrom = document.getElementById('cost-date-from');
const dateTo = document.getElementById('cost-date-to');
const btnSearch = document.getElementById('btn-cost-search');
const btnPrevPage = document.getElementById('btn-cost-prev');
const btnNextPage = document.getElementById('btn-cost-next');

let costPage = 1;
let costTotal = 0;
let costView = 'charts';

// 排行圖取毛利最高 / 最低各幾名（RPC 的 p_limit）。
const RANKING_LIMIT = 5;

// 圖表顏色直接取 DESIGN.md 的 CSS 變數，配色改一處就同步：
// 進貨沿用支出的 danger 紅、出貨沿用收益的 success 綠、毛利用強調色 primary。
const cssVars = getComputedStyle(document.documentElement);
const CHART_COLORS = {
  purchase: cssVars.getPropertyValue('--danger').trim(),
  sale: cssVars.getPropertyValue('--success').trim(),
  profit: cssVars.getPropertyValue('--primary').trim(),
  loss: cssVars.getPropertyValue('--danger').trim(),
  grid: cssVars.getPropertyValue('--border-light').trim(),
  text: cssVars.getPropertyValue('--text-main').trim()
};

// chart.js 約 200KB，只在總覽頁需要，動態 import 一次後快取，避免拖慢登入首屏。
let chartLibPromise = null;
function loadChartLib() {
  if (!chartLibPromise) {
    chartLibPromise = import('chart.js/auto').then(({ Chart }) => {
      Chart.defaults.color = CHART_COLORS.text;
      Chart.defaults.borderColor = CHART_COLORS.grid;
      Chart.defaults.font.family = "'Noto Sans TC', sans-serif";
      return Chart;
    });
  }
  return chartLibPromise;
}

// 每次重畫都先 destroy 舊 instance，否則 chart.js 會因 canvas 已被占用而報錯、
// 也會留下未回收的事件監聽造成記憶體洩漏。
let trendChart = null;
let rankingChart = null;

// month 是 Postgres 回的 'YYYY-MM-DD' 字串（每月一號）。直接字串切片轉 'YYYY/MM'，
// 不經 new Date()：避免又踩到時區把月初變成上個月底（同 CLAUDE.md 規則二的理由）。
function monthLabel(month) {
  return month.slice(0, 7).replace('-', '/');
}

// tooltip 與座標軸金額一律經 formatCurrency，與表格 / 合計同一種顯示格式。
const currencyTooltip = {
  callbacks: {
    label: ctx => `${ctx.dataset.label}：${formatCurrency(ctx.parsed.y ?? ctx.parsed.x)}`
  }
};

function renderTrendChart(Chart, rows) {
  const emptyEl = document.getElementById('cost-trend-empty');
  const canvas = document.getElementById('cost-trend-chart');

  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }

  if (rows.length === 0) {
    emptyEl.hidden = false;
    canvas.hidden = true;
    return;
  }
  emptyEl.hidden = true;
  canvas.hidden = false;

  const labels = rows.map(r => monthLabel(r.month));
  trendChart = new Chart(canvas, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: '進貨金額', data: rows.map(r => r.purchaseAmount), backgroundColor: CHART_COLORS.purchase, order: 2 },
        { type: 'bar', label: '出貨金額', data: rows.map(r => r.saleAmount), backgroundColor: CHART_COLORS.sale, order: 2 },
        { type: 'line', label: '估算毛利', data: rows.map(r => r.estimatedProfit), borderColor: CHART_COLORS.profit, backgroundColor: CHART_COLORS.profit, tension: 0.3, order: 1 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: currencyTooltip },
      scales: {
        y: { ticks: { callback: value => formatCurrency(value) } }
      }
    }
  });
}

function renderRankingChart(Chart, rows) {
  const emptyEl = document.getElementById('cost-ranking-empty');
  const canvas = document.getElementById('cost-ranking-chart');

  if (rankingChart) {
    rankingChart.destroy();
    rankingChart = null;
  }

  if (rows.length === 0) {
    emptyEl.hidden = false;
    canvas.hidden = true;
    return;
  }
  emptyEl.hidden = true;
  canvas.hidden = false;

  // 商品名稱交給 chart.js 畫在 canvas 上（非 innerHTML），沒有 XSS 面，故不需 escapeHtml。
  // 負毛利改用警示色，讓虧損商品一眼可辨。
  rankingChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.name),
      datasets: [{
        label: '毛利',
        data: rows.map(r => r.estimatedProfit),
        backgroundColor: rows.map(r => r.estimatedProfit < 0 ? CHART_COLORS.loss : CHART_COLORS.sale)
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: currencyTooltip },
      scales: {
        x: { ticks: { callback: value => formatCurrency(value) } }
      }
    }
  });
}

async function loadCharts(from, to) {
  try {
    const [Chart, trend, ranking] = await Promise.all([
      loadChartLib(),
      fetchCostTrend(from, to),
      fetchCostRanking(from, to, RANKING_LIMIT)
    ]);
    renderTrendChart(Chart, trend);
    renderRankingChart(Chart, ranking);
  } catch (error) {
    console.error('Error loading cost charts:', error);
    showToast('載入成本圖表失敗: ' + error.message, 'error');
  }
}

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

// 圖表分析 / 明細清單兩個 tab 共用上方的查詢列，切 tab 只換面板不重打 RPC。
function selectCostView(view) {
  if (view === costView) return;
  costView = view;

  document.querySelectorAll('.tabs .tab-btn').forEach(btn => {
    const isTarget = btn.getAttribute('data-view') === view;
    btn.classList.toggle('active', isTarget);
    btn.setAttribute('aria-selected', String(isTarget));
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.hidden = panel.getAttribute('data-view-panel') !== view;
  });

  // 面板從 display:none 切回來時，圖表是在 0 尺寸下畫的，需要重新量一次容器尺寸。
  // chart.js v3+ 雖有 ResizeObserver，但主動 resize 一次較保險，避免偶發塌成 0 高。
  if (view === 'charts') {
    trendChart?.resize();
    rankingChart?.resize();
  }
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

// 圖表只跟「查詢的區間」連動，翻頁（同一區間換一頁商品）不改動圖表，
// 因此圖表在此重畫、pagination 的 loadCostPage 不碰圖表，省去重複打 RPC。
function runSearch() {
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

  costPage = 1;
  loadCostPage();
  loadCharts(from, to);
}

async function loadDashboard() {
  const range = dateRange('currentMonth');
  dateFrom.value = range.from;
  dateTo.value = range.to;

  try {
    await Promise.all([
      loadMonthlySummary(range),
      loadCostPage(),
      loadCharts(range.from, range.to)
    ]);
  } catch (error) {
    console.error('Dashboard error:', error);
    showToast('載入總覽資料失敗: ' + error.message, 'error');
  }
}

requireAuth(() => {
  loadDashboard();

  btnSearch.addEventListener('click', runSearch);

  document.querySelectorAll('.tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => selectCostView(btn.getAttribute('data-view')));
  });

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
