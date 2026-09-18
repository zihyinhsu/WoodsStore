import {
  COST_PAGE_SIZE,
  fetchCostPage,
  fetchCostTotals
} from './inventory-cost.js';
import {
  PROFIT_PAGE_SIZE,
  PROFIT_RANKING_LIMIT,
  fetchPartnerProfitPage,
  fetchPartnerProfitTotals,
  fetchPartnerProfitRanking
} from './partner-profit.js';
import { openPartnerProfitModal } from './partner-profit-modal.js';
import { showToast, renderPagination, setupResponsiveTable } from './ui.js';
import { requireAuth } from './auth.js';
import { formatCurrency, dateRange, debounce, totalPages, escapeHtml } from './utils.js';

const dateFrom = document.getElementById('cost-date-from');
const dateTo = document.getElementById('cost-date-to');
const btnSearch = document.getElementById('btn-cost-search');
const btnPrevPage = document.getElementById('btn-cost-prev');
const btnNextPage = document.getElementById('btn-cost-next');
const profitSearch = document.getElementById('partner-profit-search');

let costPage = 1;
let costTotal = 0;
let costView = 'charts';

let profitPage = 1;
let profitTotal = 0;
// 客戶毛利清單有自己的關鍵字，但共用上方的日期區間（同一個「期間」只該有一種解釋）。
let profitKeyword = '';
// 清單與排行圖各自可能有在途請求（改關鍵字、翻頁、重查），只有最後一次能寫進畫面。
let profitRequestSeq = 0;

// 圖表顏色直接取 DESIGN.md 的 CSS 變數，配色改一處就同步：
// 正毛利沿用收益的 success 綠、負毛利沿用 danger 紅。
const cssVars = getComputedStyle(document.documentElement);
const CHART_COLORS = {
  sale: cssVars.getPropertyValue('--success').trim(),
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
let profitChart = null;

// 排行圖上每根長條對應的客戶，供點擊時對回 partnerId 開 modal。
let profitRankingRows = [];

// tooltip 與座標軸金額一律經 formatCurrency，與表格 / 合計同一種顯示格式。
// 毛利率在這裡算而非從 RPC 取：它是純除法，SQL 端多回一欄只是多一份會分叉的定義。
function profitTooltip(rows) {
  return {
    callbacks: {
      // 標題補上客戶編號：同名或名稱相近的客戶（「陳先生」）光看名字認不出是哪一位。
      title: items => {
        const row = rows[items[0].dataIndex];
        return row.partnerNo ? `${row.name}（${row.partnerNo}）` : row.name;
      },
      // 長條只畫得出毛利一個維度，tooltip 要答的是「這條為什麼這麼長」：
      // 6 萬毛利是做 18 萬的生意賺的，還是做 60 萬只賺這些，決策完全不同。
      label: ctx => {
        const row = rows[ctx.dataIndex];

        // 資料庫停在早期版本時拿不到出貨額／成本（見 partner-profit.js 的註解），
        // 寧可只講毛利，也不要顯示「出貨額 $0、毛利 $800」這種自相矛盾的組合。
        if (row.saleAmount === null) {
          return [`毛利：${formatCurrency(row.profit)}`];
        }

        const margin = row.saleAmount > 0
          ? `${((row.profit / row.saleAmount) * 100).toFixed(1)}%`
          : '--';

        return [
          `出貨額：${formatCurrency(row.saleAmount)}`,
          `出貨成本：${formatCurrency(row.cost)}`,
          `毛利：${formatCurrency(row.profit)}（${margin}）`,
          `出貨 ${row.orderCount} 張單`
        ];
      },
      footer: () => '點一下看商品組成'
    }
  };
}

function renderProfitChart(Chart, rows) {
  const emptyEl = document.getElementById('partner-profit-chart-empty');
  const canvas = document.getElementById('partner-profit-chart');

  profitRankingRows = rows;

  if (profitChart) {
    profitChart.destroy();
    profitChart = null;
  }

  if (rows.length === 0) {
    emptyEl.hidden = false;
    canvas.hidden = true;
    return;
  }
  emptyEl.hidden = true;
  canvas.hidden = false;

  // 客戶名稱交給 chart.js 畫在 canvas 上（非 innerHTML），沒有 XSS 面，故不需 escapeHtml。
  // 負毛利改用警示色，讓「做了生意卻虧錢」的客戶一眼可辨。
  profitChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.name),
      datasets: [{
        label: '毛利',
        data: rows.map(r => r.profit),
        backgroundColor: rows.map(r => r.profit < 0 ? CHART_COLORS.loss : CHART_COLORS.sale)
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      // intersect: false 讓滑鼠落在那一列的任何位置（含長條之外的空白）就顯示 tooltip。
      // 預設要精準壓在長條上才觸發，毛利小的客戶長條只有幾像素寬，實際上很難滑到。
      interaction: { mode: 'index', intersect: false, axis: 'y' },
      plugins: { legend: { display: false }, tooltip: profitTooltip(rows) },
      scales: {
        x: { ticks: { callback: value => formatCurrency(value) } }
      },
      // 點長條與點右側清單的列是同一個動作，都開該客戶的毛利明細。
      onClick: (_event, elements) => {
        const row = profitRankingRows[elements?.[0]?.index];
        if (row) openProfitModal(row.partnerId, row.name);
      },
      // 可點的話游標就要變手指，否則 tooltip 那句「點一下看商品組成」沒人會信。
      onHover: (event, elements) => {
        event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
      }
    }
  });

  // 游標移出畫布時 chart.js 不會再觸發 onHover，手指游標會留在畫布上不還原
  // （實測：從長條往上移出圖表後整張圖看起來都可點）。這裡自己收尾。
  // 用屬性賦值而非 addEventListener：每次查詢都會重畫，addEventListener 會疊上去。
  canvas.onmouseleave = () => { canvas.style.cursor = 'default'; };
}

async function loadProfitChart(from, to) {
  try {
    const [Chart, ranking] = await Promise.all([
      loadChartLib(),
      fetchPartnerProfitRanking(from, to, profitKeyword, PROFIT_RANKING_LIMIT)
    ]);
    renderProfitChart(Chart, ranking);
  } catch (error) {
    console.error('Error loading partner profit chart:', error);
    showToast('載入客戶毛利排行失敗: ' + error.message, 'error');
  }
}

async function loadMonthlySummary(range) {
  // 四張卡與下方明細清單共用 fetchCostTotals，口徑一律未稅、已扣整單折讓。
  // 不走 fetchPeriodSummary（那支的收益／支出含稅）：上下兩塊算法不同時，
  // 同一個月份會顯示兩組差一筆稅額的數字，看的人無從判斷哪個才算數。
  // 這裡的區間固定是本月，與下方查詢列各自獨立——改查詢區間不該動到卡片。
  const totals = await fetchCostTotals(range.from, range.to);

  document.getElementById('stat-month-revenue').textContent = formatCurrency(totals.saleAmount);
  document.getElementById('stat-month-expense').textContent = formatCurrency(totals.purchaseAmount);
  document.getElementById('stat-month-cost').textContent = formatCurrency(totals.estimatedCost);

  const profit = totals.estimatedProfit;
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

function openProfitModal(partnerId, name) {
  // modal 開啟時沿用目前查詢的區間，看的人才不會在同一頁面看到兩種「期間」。
  openPartnerProfitModal(partnerId, name, { from: dateFrom.value, to: dateTo.value });
}

function renderProfitTable(rows) {
  const tbody = document.querySelector('#partner-profit-table tbody');

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">此期間沒有客戶出貨紀錄</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(row => {
    // 分母為 0 就沒有毛利率可談，顯示 -- 而非 0%。
    const margin = row.saleAmount > 0
      ? `${((row.profit / row.saleAmount) * 100).toFixed(1)}%`
      : '--';

    // unit_cost 為 null 的出貨以 0 計入成本，毛利會偏高，標記出來而非默默呈現。
    const warn = row.noCostQty > 0
      ? ` <span title="其中 ${row.noCostQty} 件成本未知，毛利偏高">⚠</span>`
      : '';

    return `
      <tr class="clickable-row" data-id="${row.partnerId}">
        <td>
          ${escapeHtml(row.name)}${warn}
          <div class="text-muted cost-sku">${escapeHtml(row.partnerNo || '')} ‧ ${row.orderCount} 張單</div>
        </td>
        <td class="num">${formatCurrency(row.saleAmount)}</td>
        <td class="num">${formatCurrency(row.cost)}</td>
        <td class="num ${row.profit < 0 ? 'text-danger' : 'text-success'}">${formatCurrency(row.profit)}</td>
        <td class="num">${margin}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.clickable-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const row = rows.find(r => r.partnerId === tr.getAttribute('data-id'));
      if (row) openProfitModal(row.partnerId, row.name);
    });
  });
}

function renderProfitSummary(totals) {
  const marginText = totals.saleAmount > 0
    ? `${((totals.profit / totals.saleAmount) * 100).toFixed(1)}%`
    : '--';

  const el = document.getElementById('partner-profit-summary');
  // 合計來自 partner_profit_summary（對 partner_profit 加總），與清單恆等。
  // 未指定客戶的出貨單不屬於任何客戶，因此這裡的合計會小於「商品明細」的期間毛利。
  el.innerHTML = `
    ${totals.customerCount} 位客戶 ‧
    出貨額 <span class="value">${formatCurrency(totals.saleAmount)}</span> ‧
    成本 <span class="value">${formatCurrency(totals.cost)}</span> ‧
    毛利 <span class="value ${totals.profit < 0 ? 'text-danger' : 'text-success'}">${formatCurrency(totals.profit)}</span>
    （${marginText}）
  `;
  el.hidden = false;
}

async function loadProfitPage() {
  const from = dateFrom.value;
  const to = dateTo.value;

  const requestId = ++profitRequestSeq;
  const isStale = () => requestId !== profitRequestSeq;

  try {
    const [{ rows, total }, totals] = await Promise.all([
      fetchPartnerProfitPage({ from, to, keyword: profitKeyword, page: profitPage }),
      fetchPartnerProfitTotals(from, to, profitKeyword)
    ]);

    if (isStale()) return;

    profitTotal = total;
    renderProfitTable(rows);
    renderProfitSummary(totals);
    renderPagination({
      page: profitPage,
      total,
      pageSize: PROFIT_PAGE_SIZE,
      unit: '位客戶',
      pageInfoId: 'partner-profit-list-page-info',
      prevId: 'btn-partner-profit-list-prev',
      nextId: 'btn-partner-profit-list-next'
    });
  } catch (error) {
    console.error('Error loading partner profit:', error);
    if (isStale()) return;

    // 失敗時要把「載入中...」換掉：停在載入中會讓人以為還在跑而一直等。
    // 最常見的原因是資料庫還沒套用 patch-026（RPC 不存在），所以訊息要看得出是哪裡的問題。
    document.querySelector('#partner-profit-table tbody').innerHTML =
      `<tr><td colspan="5" class="empty-state text-danger">載入失敗：${escapeHtml(error.message)}</td></tr>`;
    document.getElementById('partner-profit-summary').hidden = true;
    showToast('載入客戶毛利失敗: ' + error.message, 'error');
  }
}

// 客戶毛利 / 商品明細兩個 tab 共用上方的查詢列，切 tab 只換面板不重打 RPC。
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
    profitChart?.resize();
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

// 排行圖只跟「查詢的區間與關鍵字」連動，翻頁（同一條件換一頁客戶或商品）不重畫圖，
// 因此圖在此重畫、兩支 loadXxxPage 都不碰圖，省去重複打 RPC。
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

  // 換區間等於換一組資料，兩份清單的頁碼都必須歸 1，
  // 否則停在第 3 頁時改區間會落在新結果的空白頁。
  costPage = 1;
  profitPage = 1;
  loadCostPage();
  loadProfitPage();
  loadProfitChart(from, to);
}

async function loadDashboard() {
  const range = dateRange('currentMonth');
  dateFrom.value = range.from;
  dateTo.value = range.to;

  try {
    await Promise.all([
      loadMonthlySummary(range),
      loadCostPage(),
      loadProfitPage(),
      loadProfitChart(range.from, range.to)
    ]);
  } catch (error) {
    console.error('Dashboard error:', error);
    showToast('載入總覽資料失敗: ' + error.message, 'error');
  }
}

requireAuth(() => {
  setupResponsiveTable('#cost-table');
  setupResponsiveTable('#partner-profit-table');
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

  // 關鍵字改動同樣要歸 1；debounce 300ms 與商品／單據頁的搜尋一致。
  profitSearch.addEventListener('input', debounce(() => {
    profitKeyword = profitSearch.value;
    profitPage = 1;
    loadProfitPage();
    loadProfitChart(dateFrom.value, dateTo.value);
  }, 300));

  document.getElementById('btn-partner-profit-list-prev').addEventListener('click', () => {
    if (profitPage > 1) {
      profitPage--;
      loadProfitPage();
    }
  });

  document.getElementById('btn-partner-profit-list-next').addEventListener('click', () => {
    if (profitPage < totalPages(profitTotal, PROFIT_PAGE_SIZE)) {
      profitPage++;
      loadProfitPage();
    }
  });
});
