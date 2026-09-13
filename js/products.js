import { sb } from './supabase.js';
import { formatCurrency, formatDate, debounce, showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce } from './ui.js';

const PAGE_SIZE = 10;
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

  return query;
}

async function loadProducts(keyword = '') {
  try {
    const from = (currentPage - 1) * PAGE_SIZE;
    const query = applyProductFilters(
      sb.from(VIEW_SOURCES[currentView])
        .select('*', { count: 'exact' })
        .order('sku', { ascending: true })
        .range(from, from + PAGE_SIZE - 1),
      keyword
    );

    const { data, error, count } = await query;
    if (error) throw error;

    currentProducts = data;
    totalCount = count || 0;
    renderProductsTable(data);
    renderPagination();
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

function renderPagination() {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  document.getElementById('page-info').textContent =
    `第 ${currentPage} / ${totalPages} 頁 (共 ${totalCount} 筆)`;
  document.getElementById('btn-prev-page').disabled = currentPage <= 1;
  document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
}

function renderProductsTable(products) {
  const tbody = document.querySelector('#products-table tbody');
  if (products.length === 0) {
    const message = currentView === 'low-stock'
      ? '目前無庫存不足的商品'
      : '找不到商品';
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
    return;
  }

  tbody.innerHTML = products.map(p => `
    <tr class="clickable-row" data-id="${p.id}">
      <td>${p.sku}</td>
      <td>
        <div>${p.name}</div>
        ${p.spec ? `<small class="text-muted">${p.spec}</small>` : ''}
      </td>
      <td>${p.category || '-'}</td>
      <td>
        <span class="${p.stock_qty < p.safety_stock ? 'text-danger font-weight-bold' : ''}">
          ${p.stock_qty} ${p.unit}
        </span>
      </td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.cost)}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.price)}</td>
      <td>
        ${p.is_active 
          ? '<span class="badge badge-green">啟用</span>' 
          : '<span class="badge badge-gray">停用</span>'}
      </td>
      <td>
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

  document.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-edit') || e.target.closest('.badge')) return;
      openCostModal(row.getAttribute('data-id'));
    });
  });
}

let costModalProductId = null;

function openCostModal(productId) {
  costModalProductId = productId;

  const product = currentProducts.find(p => p.id === productId);
  document.getElementById('cost-modal-title').textContent =
    `進出貨成本分析 - ${product ? product.name : ''}`;

  const modal = document.getElementById('cost-modal');
  const today = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(today.getDate() - 30);

  const fromInput = modal.querySelector('.cost-date-from');
  const toInput = modal.querySelector('.cost-date-to');
  fromInput.value = thirtyDaysAgo.toISOString().split('T')[0];
  toInput.value = today.toISOString().split('T')[0];

  openModal('cost-modal');
  loadCostAnalysisData(productId, modal, fromInput.value, toInput.value);
}

function setupCostModalControls() {
  const modal = document.getElementById('cost-modal');
  const fromInput = modal.querySelector('.cost-date-from');
  const toInput = modal.querySelector('.cost-date-to');

  const reloadData = () => {
    if (!costModalProductId) return;
    loadCostAnalysisData(costModalProductId, modal, fromInput.value, toInput.value);
  };

  fromInput.addEventListener('change', reloadData);
  toInput.addEventListener('change', reloadData);

  modal.querySelectorAll('.btn-quick-date').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const range = e.target.dataset.range;
      const t = new Date();
      let f = new Date();
      let end = new Date();

      if (range === 'thisMonth') {
        f = new Date(t.getFullYear(), t.getMonth(), 1);
        end = t;
      } else if (range === 'lastMonth') {
        f = new Date(t.getFullYear(), t.getMonth() - 1, 1);
        end = new Date(t.getFullYear(), t.getMonth(), 0);
      } else if (range === 'last30Days') {
        f.setDate(t.getDate() - 30);
        end = t;
      } else if (range === 'all') {
        fromInput.value = '';
        toInput.value = '';
        reloadData();
        return;
      }

      fromInput.value = f.toISOString().split('T')[0];
      toInput.value = end.toISOString().split('T')[0];
      reloadData();
    });
  });
}

async function loadCostAnalysisData(productId, container, from, to) {
  const contentDiv = container.querySelector('.cost-analysis-content');
  contentDiv.innerHTML = '載入中...';
  
  try {
    let q = sb.from('order_items')
      .select('qty, unit_price, discount, subtotal, orders!inner(order_no, order_date, type, status)')
      .eq('product_id', productId)
      .eq('orders.status', 'confirmed')
      .order('order_date', { referencedTable: 'orders', ascending: false });
      
    if (from) q = q.gte('orders.order_date', from);
    if (to)   q = q.lte('orders.order_date', to);
    
    const { data, error } = await q;
    if (error) throw error;
    
    const product = currentProducts.find(p => p.id === productId);
    const unit = product ? product.unit : '個';
    
    let purchaseQty = 0;
    let purchaseAmount = 0;
    let saleQty = 0;
    let saleAmount = 0;
    
    data.forEach(item => {
      if (item.orders.type === 'purchase') {
        purchaseQty += item.qty;
        purchaseAmount += item.subtotal;
      } else if (item.orders.type === 'sale') {
        saleQty += Math.abs(item.qty);
        saleAmount += item.subtotal;
      }
    });
    
    const avgPurchaseCost = purchaseQty > 0 ? purchaseAmount / purchaseQty : 0;
    const avgSalePrice = saleQty > 0 ? saleAmount / saleQty : 0;
    
    let grossProfit = '--';
    let grossMargin = '--';
    let marginClass = '';
    
    if (purchaseQty > 0 && saleQty > 0) {
      const profit = saleAmount - (avgPurchaseCost * saleQty);
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
    
    const displayData = data.slice(0, 50);
    const hasMore = data.length > 50;
    
    const typeMap = {
      'purchase': '<span class="badge badge-blue">進貨</span>',
      'sale': '<span class="badge badge-green">出貨</span>',
      'adjust': '<span class="badge badge-gray">調整</span>'
    };
    
    let recordsHtml = '';
    if (data.length === 0) {
      recordsHtml = '<div class="empty-state" style="padding: 2rem; border: 2px solid #1f1f1f; text-align: center; color: #666;">此區間無進出紀錄</div>';
    } else {
      const rowsHtml = displayData.map(item => {
        const isAdjust = item.orders.type === 'adjust';
        const isSale = item.orders.type === 'sale';
        const isPurchase = item.orders.type === 'purchase';
        
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
            <td>${formatDate(item.orders.order_date)}</td>
            <td>${item.orders.order_no}</td>
            <td>${typeMap[item.orders.type]}</td>
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
      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-card-title">平均進貨成本</div>
          <div class="stat-card-value">${purchaseQty > 0 ? formatCurrency(avgPurchaseCost) : '--'}</div>
          <div class="stat-card-subtitle">進${purchaseQty}${unit} ${formatCurrency(purchaseAmount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-title">平均出貨單價</div>
          <div class="stat-card-value">${saleQty > 0 ? formatCurrency(avgSalePrice) : '--'}</div>
          <div class="stat-card-subtitle">出${saleQty}${unit} ${formatCurrency(saleAmount)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-title">毛利</div>
          <div class="stat-card-value">${grossProfit}</div>
          <div class="stat-card-subtitle">出貨總額 - (平均進貨成本 × 出貨量)</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-title">毛利率</div>
          <div class="stat-card-value ${marginClass}">${grossMargin}</div>
          <div class="stat-card-subtitle">毛利 ÷ 出貨總額</div>
        </div>
      </div>
      
      <h5 style="margin: 0 0 1rem 0; color: #1f1f1f; font-size: 1rem;">區間內進出紀錄 ${hasMore ? '<span class="text-muted" style="font-size: 0.8rem; font-weight: normal;">(僅顯示前 50 筆)</span>' : ''}</h5>
      ${recordsHtml}
    `;
    
  } catch (error) {
    console.error('Error loading cost analysis:', error);
    contentDiv.innerHTML = `<div class="text-danger">載入失敗: ${error.message}</div>`;
    showToast('載入成本分析失敗: ' + error.message, 'error');
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
    cost: parseFloat(document.getElementById('product-cost').value) || 0,
    price: parseFloat(document.getElementById('product-price').value) || 0,
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

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('search-input');

  const hashMatch = window.location.hash.match(/^#search=(.+)$/);
  const urlSearch = new URLSearchParams(window.location.search).get('search')
    || (hashMatch ? decodeURIComponent(hashMatch[1]) : null);
  if (urlSearch) {
    searchInput.value = urlSearch;
    document.getElementById('status-filter').value = 'all';
  }

  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (VIEW_SOURCES[hashParams.get('view')]) {
    selectView(hashParams.get('view'));
  }

  loadProducts(urlSearch || '');
  setupCostModalControls();

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
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage++;
      loadProducts(searchInput.value);
    }
  });

  document.getElementById('btn-add-product').addEventListener('click', () => {
    openEditModal();
  });

  bindSubmitOnce('btn-save-product', saveProduct);
});
