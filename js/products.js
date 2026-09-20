import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce, renderPagination, setupResponsiveTable } from './ui.js';
import { requireAuth } from './auth.js';
import { PAGE_SIZE, formatCurrency, formatDate, dateRange, debounce, totalPages, escapeHtml, toDateInputValue, orderSearchLink, round2 } from './utils.js';
import { MOVEMENT_PAGE_SIZE, fetchProductCostSummary, fetchProductMovementPage } from './inventory-cost.js';

let currentProducts = [];
let currentPage = 1;
let totalCount = 0;
let currentView = 'all';

// 庫存不足＝stock_qty < safety_stock，該比較跨欄位，PostgREST 的 filter 做不到，
// 因此改查 low_stock_view（已在 SQL 端算好）。
const VIEW_SOURCES = { all: 'stock_view', 'low-stock': 'low_stock_view' };

function selectView(view) {
  currentView = view;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isTarget = btn.getAttribute('data-view') === view;
    btn.classList.toggle('active', isTarget);
    btn.setAttribute('aria-selected', String(isTarget));
  });
}

function applyProductFilters(query, keyword) {
  const statusFilter = document.getElementById('status-filter').value;
  if (statusFilter === 'active') {
    query = query.eq('is_active', true);
  } else if (statusFilter === 'inactive') {
    query = query.eq('is_active', false);
  }

  if (keyword) {
    query = query.or(`name.ilike.%${keyword}%,sku.ilike.%${keyword}%,category.ilike.%${keyword}%`);
  }

  // 儲位與關鍵字是 AND：儲位命名有層級（A-01、A-02），打「A」要能收斂到整排貨架，
  // 因此用模糊比對而非完全相等。
  const location = document.getElementById('location-input').value.trim();
  if (location) {
    query = query.ilike('location', `%${location}%`);
  }

  return query;
}

async function loadProducts(keyword = '') {
  try {
    const from = (currentPage - 1) * PAGE_SIZE;
    const query = applyProductFilters(
      sb.from(VIEW_SOURCES[currentView])
        .select('*', { count: 'exact' })
        .order('sku', { ascending: false })
        .range(from, from + PAGE_SIZE - 1),
      keyword
    );

    const { data, error, count } = await query;
    if (error) throw error;

    currentProducts = data;
    totalCount = count || 0;
    renderProductsTable(data);
    renderPagination({ page: currentPage, total: totalCount, pageSize: PAGE_SIZE });
    refreshLowStockCount();
  } catch (error) {
    console.error('Error loading products:', error);
    showToast('載入商品失敗: ' + error.message, 'error');
  }
}

// 標記固定顯示「啟用中」的缺貨數，不跟著狀態篩選或關鍵字變動，
// 否則搜尋時數字會忽大忽小，失去「還有幾項要補貨」的意義。
async function refreshLowStockCount() {
  const badge = document.getElementById('low-stock-count');

  const { count, error } = await sb
    .from('low_stock_view')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  if (error) {
    badge.hidden = true;
    return;
  }

  badge.textContent = count || 0;
  badge.hidden = !count;
}



function renderProductsTable(products) {
  const tbody = document.querySelector('#products-table tbody');
  if (products.length === 0) {
    const message = currentView === 'low-stock'
      ? '目前無庫存不足的商品'
      : '找不到商品';
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${message}</td></tr>`;
    return;
  }

  tbody.innerHTML = products.map(p => `
    <tr class="clickable-row" data-id="${p.id}">
      <td>${escapeHtml(p.sku)}</td>
      <td>
        <div>${escapeHtml(p.name)}</div>
        ${p.spec ? `<small class="text-muted">${escapeHtml(p.spec)}</small>` : ''}
      </td>
      <td>${escapeHtml(p.category || '-')}</td>
      <td>
        <span class="${p.stock_qty < p.safety_stock ? 'text-danger font-weight-bold' : ''}">
          ${p.stock_qty} ${escapeHtml(p.unit)}
        </span>
      </td>
      <td>${escapeHtml(p.location || '-')}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.cost)}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.price)}</td>
      <td>
        ${p.is_active 
          ? '<span class="badge badge-green">啟用</span>' 
          : '<span class="badge badge-gray">停用</span>'}
      </td>
      <td>
        <button class="btn btn-outline btn-adjust" data-id="${p.id}">調整</button>
        <button class="btn btn-outline btn-edit" data-id="${p.id}">編輯</button>
      </td>
    </tr>
  `).join('');

  // Attach edit events
  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.target.getAttribute('data-id');
      const product = currentProducts.find(p => p.id === id);
      if (product) openEditModal(product);
    });
  });

  document.querySelectorAll('.btn-adjust').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAdjustModal(e.target.getAttribute('data-id'));
    });
  });

  document.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-edit') || e.target.closest('.btn-adjust') || e.target.closest('.badge')) return;
      openCostModal(row.getAttribute('data-id'));
    });
  });
}

let costModalProductId = null;
let costMovementPage = 1;
let costMovementTotal = 0;

// 每次查詢取一個遞增序號，只有最後發出的那次可以寫進畫面。
// 沒有這道閘門時，連開商品 A、B 若 A 的回應較慢，會蓋掉 B 的內容，
// 變成標題是 B、數字是 A。改日期與翻頁也有同樣的競態。
let costRequestSeq = 0;

function openCostModal(productId) {
  costModalProductId = productId;
  costMovementPage = 1;
  costMovementTotal = 0;

  const product = currentProducts.find(p => p.id === productId);
  document.getElementById('cost-modal-title').textContent =
    `進出貨成本分析 - ${product ? product.name : ''}`;

  const modal = document.getElementById('cost-modal');
  const defaultRange = dateRange('last30Days');

  const fromInput = modal.querySelector('.cost-date-from');
  const toInput = modal.querySelector('.cost-date-to');
  fromInput.value = defaultRange.from;
  toInput.value = defaultRange.to;

  openModal('cost-modal');
  loadCostAnalysisData(productId, modal, fromInput.value, toInput.value);
}

function setupCostModalControls() {
  const modal = document.getElementById('cost-modal');
  const fromInput = modal.querySelector('.cost-date-from');
  const toInput = modal.querySelector('.cost-date-to');

  // 換日期區間等於換一組資料，頁碼必須歸 1，
  // 否則停在第 5 頁時改區間會落在新結果的空白頁。
  const reloadData = () => {
    if (!costModalProductId) return;
    costMovementPage = 1;
    costMovementTotal = 0;
    loadCostAnalysisData(costModalProductId, modal, fromInput.value, toInput.value);
  };

  fromInput.addEventListener('change', reloadData);
  toInput.addEventListener('change', reloadData);

  modal.querySelectorAll('.btn-quick-date').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const { from, to } = dateRange(e.target.dataset.range);
      fromInput.value = from;
      toInput.value = to;
      reloadData();
    });
  });

  // 夾在合法範圍內，不能只靠按鈕的 disabled 狀態：請求還在飛的時候連點兩次下一頁，
  // 第二次點擊時按鈕尚未依新結果更新，頁碼就會衝過最後一頁而顯示空白表格。
  const goToPage = (delta) => {
    if (!costModalProductId) return;

    const lastPage = totalPages(costMovementTotal, MOVEMENT_PAGE_SIZE);
    const nextPage = Math.min(Math.max(costMovementPage + delta, 1), lastPage);
    if (nextPage === costMovementPage) return;

    costMovementPage = nextPage;
    loadCostAnalysisData(costModalProductId, modal, fromInput.value, toInput.value);
  };

  document.getElementById('btn-cost-prev-page').addEventListener('click', () => goToPage(-1));
  document.getElementById('btn-cost-next-page').addEventListener('click', () => goToPage(1));
}

async function loadCostAnalysisData(productId, container, from, to) {
  const contentDiv = container.querySelector('.cost-analysis-content');
  contentDiv.innerHTML = '載入中...';

  const requestId = ++costRequestSeq;
  const isStale = () => requestId !== costRequestSeq;

  try {
    // 聚合與明細分兩支 RPC：聚合在 SQL 端掃全期間只回一列，明細一次只取當頁。
    // 舊版是把該商品所有 order_items 撈回瀏覽器再 slice(0, 50)，交易筆數一多就明顯拖慢。
    const [summary, movements] = await Promise.all([
      fetchProductCostSummary(productId, from, to),
      fetchProductMovementPage({ productId, from, to, page: costMovementPage })
    ]);

    if (isStale()) return;

    costMovementTotal = movements.total;

    const { saleQty, saleAmount, cost } = summary;

    const product = currentProducts.find(p => p.id === productId);
    const unit = product ? product.unit : '個';

    // 成本改用出貨成本快照：cost 是 Σ(每筆出貨 unit_cost × 數量)，
    // 不再拿查詢區間的進貨均價估算，換區間也不會變。
    const avgSaleCost = saleQty > 0 ? cost / saleQty : 0;
    const avgSalePrice = saleQty > 0 ? saleAmount / saleQty : 0;

    let grossProfit = '--';
    let grossMargin = '--';
    let marginClass = '';

    // 只要有出貨就能算毛利：成本來自出貨當下的快照，與這區間有沒有進貨無關
    //（賣舊庫存、本期未進貨的商品也該顯示毛利）。
    if (saleQty > 0) {
      const profit = saleAmount - cost;
      grossProfit = formatCurrency(profit);

      if (saleAmount > 0) {
        const margin = (profit / saleAmount) * 100;
        grossMargin = margin.toFixed(1) + '%';
        if (margin < 0) {
          marginClass = 'negative';
          grossMargin = '▲' + grossMargin;
        }
      }
    }
    
    const typeMap = {
      'purchase': '<span class="badge badge-blue">進貨</span>',
      'sale': '<span class="badge badge-green">出貨</span>',
      'adjust': '<span class="badge badge-gray">調整</span>'
    };
    
    let recordsHtml = '';
    if (movements.total === 0) {
      recordsHtml = '<div class="empty-state" style="padding: 2rem; border: 2px solid #1f1f1f; text-align: center; color: #666;">此區間無進出紀錄</div>';
    } else {
      const rowsHtml = movements.rows.map(item => {
        const isAdjust = item.type === 'adjust';
        const isSale = item.type === 'sale';
        const isPurchase = item.type === 'purchase';
        
        let qtyStr = item.qty;
        if (isPurchase) qtyStr = '+' + item.qty;
        if (isSale) qtyStr = '-' + Math.abs(item.qty);
        if (isAdjust) qtyStr = item.qty > 0 ? '+' + item.qty : item.qty;
        
        let priceStr = '--';
        let amountStr = '--';
        
        if (!isAdjust) {
          const effectivePrice = Math.abs(item.qty) > 0 ? item.subtotal / Math.abs(item.qty) : 0;
          priceStr = formatCurrency(effectivePrice);
          amountStr = formatCurrency(item.subtotal);
        }
        
        return `
          <tr class="${isAdjust ? 'adjust-row' : ''}">
            <td>${formatDate(item.order_date)}</td>
            <td>${orderSearchLink(item.order_no, item.order_date)}</td>
            <td>${typeMap[item.type]}</td>
            <td class="num-col">${qtyStr}</td>
            <td class="num-col">${priceStr}</td>
            <td class="num-col">${amountStr}</td>
          </tr>
        `;
      }).join('');
      
      recordsHtml = `
        <table class="records-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>單號</th>
              <th>類型</th>
              <th>數量</th>
              <th>單價</th>
              <th>金額</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      `;
    }
    
    contentDiv.innerHTML = `
      <div class="metric-cards">
        <div class="metric-card">
          <div class="metric-card-title">期間出貨收益</div>
          <div class="metric-card-value">${saleQty > 0 ? formatCurrency(saleAmount) : '--'}</div>
          <div class="metric-card-subtitle">出${saleQty}${escapeHtml(unit)} 均價 ${formatCurrency(avgSalePrice)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-title">期間出貨成本</div>
          <div class="metric-card-value">${saleQty > 0 ? formatCurrency(cost) : '--'}</div>
          <div class="metric-card-subtitle">出${saleQty}${escapeHtml(unit)} 均 ${formatCurrency(avgSaleCost)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-title">毛利</div>
          <div class="metric-card-value">${grossProfit}</div>
          <div class="metric-card-subtitle">出貨總額 − 出貨成本快照</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-title">毛利率</div>
          <div class="metric-card-value ${marginClass}">${grossMargin}</div>
          <div class="metric-card-subtitle">毛利 ÷ 出貨總額</div>
        </div>
      </div>
      
      <h5 style="margin: 0 0 1rem 0; color: #1f1f1f; font-size: 1rem;">區間內進出紀錄</h5>
      ${recordsHtml}
    `;

    const pagination = document.getElementById('cost-pagination');
    pagination.hidden = movements.total === 0;
    renderPagination({
      page: costMovementPage,
      total: movements.total,
      pageSize: MOVEMENT_PAGE_SIZE,
      pageInfoId: 'cost-page-info',
      prevId: 'btn-cost-prev-page',
      nextId: 'btn-cost-next-page'
    });

  } catch (error) {
    console.error('Error loading cost analysis:', error);
    if (isStale()) return;

    contentDiv.innerHTML = `<div class="text-danger">載入失敗: ${escapeHtml(toErrorMessage(error))}</div>`;
    document.getElementById('cost-pagination').hidden = true;
    showToast('載入成本分析失敗: ' + toErrorMessage(error), 'error');
  }
}

function openEditModal(product = null) {
  const form = document.getElementById('product-form');
  form.reset();
  
  if (product) {
    document.getElementById('modal-title').textContent = '編輯商品';
    document.getElementById('product-id').value = product.id;
    document.getElementById('product-sku').value = product.sku || '';
    document.getElementById('product-name').value = product.name || '';
    document.getElementById('product-category').value = product.category || '';
    document.getElementById('product-unit').value = product.unit || '個';
    document.getElementById('product-cost').value = product.cost || 0;
    document.getElementById('product-price').value = product.price || 0;
    document.getElementById('product-safety-stock').value = product.safety_stock || 0;
    document.getElementById('product-location').value = product.location || '';
    document.getElementById('product-tax-type').value = product.tax_type || 'taxable';
    document.getElementById('product-is-active').value = product.is_active ? 'true' : 'false';
    document.getElementById('product-spec').value = product.spec || '';
  } else {
    document.getElementById('modal-title').textContent = '新增商品';
    document.getElementById('product-id').value = '';
  }

  document.getElementById('product-sku-hint').style.display = product ? 'none' : '';

  openModal('product-modal');
}

async function saveProduct() {
  const form = document.getElementById('product-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const id = document.getElementById('product-id').value;
  const productData = {
    sku: document.getElementById('product-sku').value.trim() || null,
    name: document.getElementById('product-name').value,
    category: document.getElementById('product-category').value || null,
    unit: document.getElementById('product-unit').value || '個',
    // round2：金額欄位允許手打小數，收斂到分再存，避免 1500.005 這種值進 numeric(12,2)
    cost: round2(document.getElementById('product-cost').value),
    price: round2(document.getElementById('product-price').value),
    safety_stock: parseInt(document.getElementById('product-safety-stock').value) || 0,
    location: document.getElementById('product-location').value || null,
    tax_type: document.getElementById('product-tax-type').value,
    is_active: document.getElementById('product-is-active').value === 'true',
    spec: document.getElementById('product-spec').value || null
  };

  try {
    let error;
    if (id) {
      const res = await sb.from('products').update(productData).eq('id', id);
      error = res.error;
    } else {
      const res = await sb.from('products').insert([productData]);
      error = res.error;
    }

    if (error) throw error;

    showToast(id ? '商品更新成功' : '商品新增成功', 'success');
    closeModal('product-modal');
    loadProducts(document.getElementById('search-input').value);
  } catch (error) {
    console.error('Error saving product:', error);
    showToast('儲存失敗：' + toErrorMessage(error), 'error');
  }
}

// 單品庫存調整：改的是「盤點後的實際數量」，送出時反算差額寫成一筆 adjust 流水帳。
// 不直接改 stock_qty——庫存是流水帳，當前值由異動累加而來，直接覆寫會失去追溯。
let adjustProductId = null;
let adjustCurrentStock = 0;
let adjustUnit = '';

function openAdjustModal(productId) {
  const product = currentProducts.find(p => p.id === productId);
  if (!product) return;

  adjustProductId = productId;
  adjustCurrentStock = product.stock_qty;
  adjustUnit = product.unit || '';

  document.getElementById('adjust-form').reset();
  document.getElementById('adjust-modal-title').textContent =
    `庫存調整 — ${product.name}（${product.sku}）`;
  document.getElementById('adjust-current-stock').textContent =
    `${adjustCurrentStock} ${adjustUnit}`;
  // 不能用 toISOString()：會先轉 UTC，台北時間當天 08:00 前會變成前一天。
  document.getElementById('adjust-date').value = toDateInputValue(new Date());

  updateAdjustDiff();
  openModal('adjust-modal');
}

function updateAdjustDiff() {
  const hint = document.getElementById('adjust-diff-hint');
  const raw = document.getElementById('adjust-count').value;

  if (raw === '') {
    hint.textContent = '輸入盤點後的實際數量，系統會自動算出差額';
    hint.classList.remove('text-danger');
    return;
  }

  const diff = (parseInt(raw) || 0) - adjustCurrentStock;
  const after = adjustCurrentStock + diff;
  if (diff === 0) {
    hint.textContent = `數量未變動（${adjustCurrentStock} ${adjustUnit}）`;
  } else {
    const sign = diff > 0 ? '+' : '';
    hint.textContent = `差額：${sign}${diff} ${adjustUnit}（${adjustCurrentStock} → ${after}）`;
  }
  hint.classList.remove('text-danger');
}

async function saveAdjustment() {
  const form = document.getElementById('adjust-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const diff = (parseInt(document.getElementById('adjust-count').value) || 0) - adjustCurrentStock;
  if (diff === 0) {
    const hint = document.getElementById('adjust-diff-hint');
    hint.textContent = '數量未變動，無需調整';
    hint.classList.add('text-danger');
    return;
  }

  try {
    // 走與進貨／出貨相同的 create_order：調整單無往來對象、無金額，
    // qty 帶正負號代表增減，unit_price／discount 對 adjust 無意義故填 0。
    const { error } = await sb.rpc('create_order', {
      p_type: 'adjust',
      p_partner: null,
      p_items: [{ product_id: adjustProductId, qty: diff, unit_price: 0, discount: 0 }],
      p_note: document.getElementById('adjust-note').value || null,
      p_order_date: document.getElementById('adjust-date').value,
      p_discount: 0,
      p_tax: 0,
      p_status: 'confirmed'
    });
    if (error) throw error;

    showToast('庫存已調整', 'success');
    closeModal('adjust-modal');
    loadProducts(document.getElementById('search-input').value);
  } catch (error) {
    console.error('Error saving adjustment:', error);
    showToast('調整失敗：' + toErrorMessage(error), 'error');
  }
}

// Event Listeners
requireAuth(() => {
  const searchInput = document.getElementById('search-input');

  const hashMatch = window.location.hash.match(/^#search=(.+)$/);
  const urlSearch = new URLSearchParams(window.location.search).get('search')
    || (hashMatch ? decodeURIComponent(hashMatch[1]) : null);
  if (urlSearch) {
    searchInput.value = urlSearch;
    document.getElementById('status-filter').value = 'all';
  }

  const viewFromHash = () =>
    new URLSearchParams(window.location.hash.slice(1)).get('view');

  if (VIEW_SOURCES[viewFromHash()]) {
    selectView(viewFromHash());
  }

  setupResponsiveTable('#products-table');
  loadProducts(urlSearch || '');
  setupCostModalControls();

  // 從本頁連到 products.html#view=... 時網址只差 hash，瀏覽器視為同文件跳轉
  // 而不重新載入，初始化不會再跑一次，必須在這裡補切換。
  window.addEventListener('hashchange', () => {
    const view = viewFromHash();
    if (!VIEW_SOURCES[view] || view === currentView) return;

    selectView(view);
    currentPage = 1;
    loadProducts(searchInput.value);
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      if (view === currentView) return;

      selectView(view);
      currentPage = 1;
      loadProducts(searchInput.value);
    });
  });

  searchInput.addEventListener('input', debounce((e) => {
    currentPage = 1;
    loadProducts(e.target.value);
  }, 300));

  document.getElementById('location-input').addEventListener('input', debounce(() => {
    currentPage = 1;
    loadProducts(searchInput.value);
  }, 300));

  document.getElementById('status-filter').addEventListener('change', () => {
    currentPage = 1;
    loadProducts(searchInput.value);
  });

  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadProducts(searchInput.value);
    }
  });

  document.getElementById('btn-next-page').addEventListener('click', () => {
    if (currentPage < totalPages(totalCount)) {
      currentPage++;
      loadProducts(searchInput.value);
    }
  });

  document.getElementById('btn-add-product').addEventListener('click', () => {
    openEditModal();
  });

  bindSubmitOnce('btn-save-product', saveProduct);

  document.getElementById('adjust-count').addEventListener('input', updateAdjustDiff);
  bindSubmitOnce('btn-save-adjust', saveAdjustment);
});
