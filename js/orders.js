import { sb } from './supabase.js';
import { formatCurrency, formatDate, debounce, showToast, openModal, closeModal } from './ui.js';

const PAGE_SIZE = 20;
let currentPage = 1;
let totalCount = 0;
let currentOrders = [];
let productsCache = [];
let partnersCache = [];

// DOM Elements
const searchDateFrom = document.getElementById('search-date-from');
const searchDateTo = document.getElementById('search-date-to');
const searchType = document.getElementById('search-type');
const searchStatus = document.getElementById('search-status');
const searchKeyword = document.getElementById('search-keyword');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const pageInfo = document.getElementById('page-info');

async function init() {
  // Parse URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  
  // Set default date range (last 30 days) if not in URL
  const today = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(today.getDate() - 30);
  
  searchDateTo.value = urlParams.get('to') || today.toISOString().split('T')[0];
  searchDateFrom.value = urlParams.get('from') || thirtyDaysAgo.toISOString().split('T')[0];
  searchType.value = urlParams.get('type') || 'all';
  searchStatus.value = urlParams.get('status') || 'active';
  searchKeyword.value = urlParams.get('q') || '';
  currentPage = parseInt(urlParams.get('page')) || 1;
  
  document.getElementById('order-date').value = today.toISOString().split('T')[0];

  // Load initial data
  await Promise.all([
    loadProductsCache(),
    loadPartnersCache(),
    loadOrders()
  ]);

  setupEventListeners();
}

async function loadProductsCache() {
  const { data } = await sb.from('stock_view').select('*').eq('is_active', true);
  productsCache = data || [];
}

async function loadPartnersCache() {
  const { data } = await sb.from('partners').select('*');
  partnersCache = data || [];
}

function updateUrlParams() {
  const urlParams = new URLSearchParams();
  if (searchDateFrom.value) urlParams.set('from', searchDateFrom.value);
  if (searchDateTo.value) urlParams.set('to', searchDateTo.value);
  if (searchType.value !== 'all') urlParams.set('type', searchType.value);
  if (searchStatus.value !== 'active') urlParams.set('status', searchStatus.value);
  if (searchKeyword.value) urlParams.set('q', searchKeyword.value);
  if (currentPage > 1) urlParams.set('page', currentPage);
  
  const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
  window.history.replaceState({}, '', newUrl);
}

async function loadOrders() {
  updateUrlParams();
  try {
    let query = sb.from('order_search_view').select('*', { count: 'exact' });

    // Apply filters
    if (searchDateFrom.value) query = query.gte('order_date', searchDateFrom.value);
    if (searchDateTo.value) query = query.lte('order_date', searchDateTo.value);
    
    if (searchType.value !== 'all') {
      query = query.eq('type', searchType.value);
    }

    if (searchStatus.value === 'active') {
      query = query.in('status', ['draft', 'confirmed']);
    } else if (searchStatus.value !== 'all') {
      query = query.eq('status', searchStatus.value);
    }

    if (searchKeyword.value) {
      query = query.ilike('search_text', `%${searchKeyword.value}%`);
    }

    // Pagination
    const from = (currentPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    query = query.order('order_date', { ascending: false }).order('created_at', { ascending: false }).range(from, to);

    const { data, count, error } = await query;
    if (error) throw error;

    currentOrders = data;
    totalCount = count;
    
    renderOrdersTable();
    updatePagination();
  } catch (error) {
    console.error('Error loading orders:', error);
    showToast('載入單據失敗: ' + error.message, 'error');
  }
}

function renderOrdersTable() {
  const tbody = document.querySelector('#orders-table tbody');
  if (currentOrders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">找不到單據</td></tr>';
    return;
  }

  const typeMap = {
    'purchase': '<span class="badge badge-blue">進貨</span>',
    'sale': '<span class="badge badge-green">銷貨</span>',
    'adjust': '<span class="badge badge-orange">調整</span>'
  };

  const statusMap = {
    'draft': '<span class="badge badge-gray">草稿</span>',
    'confirmed': '<span class="badge badge-green">已確認</span>',
    'void': '<span class="badge badge-red">已作廢</span>'
  };

  const paymentMap = {
    'unpaid': '<span class="text-danger">未付款</span>',
    'partial': '<span class="text-warning">部分付款</span>',
    'paid': '<span class="text-success">已付款</span>'
  };

  const paymentSelect = (order) => `
    <select class="form-control payment-select" data-id="${order.id}"
            style="padding: 0.25rem 0.5rem; font-size: 0.85rem; width: auto;">
      <option value="unpaid" ${order.payment_status === 'unpaid' ? 'selected' : ''}>未付款</option>
      <option value="partial" ${order.payment_status === 'partial' ? 'selected' : ''}>部分付款</option>
      <option value="paid" ${order.payment_status === 'paid' ? 'selected' : ''}>已付款</option>
    </select>`;

  tbody.innerHTML = currentOrders.map(order => `
    <tr class="clickable-row" data-id="${order.id}">
      <td>${formatDate(order.order_date)}</td>
      <td>${order.order_no}</td>
      <td>${typeMap[order.type]}</td>
      <td>${statusMap[order.status]}</td>
      <td>${order.partner_name || '-'}</td>
      <td>${order.item_count}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(order.total_amount)}</td>
      <td>${order.status === 'confirmed' ? paymentSelect(order) : paymentMap[order.payment_status]}</td>
      <td>
        ${order.status === 'draft' ?
          `<button class="btn btn-primary btn-confirm" data-id="${order.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">確認</button> ` :
          ''}
        ${order.status !== 'void' ?
          `<button class="btn btn-outline btn-void" data-id="${order.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">作廢</button>` :
          ''}
      </td>
    </tr>
  `).join('');

  // Attach events
  document.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-void')) return;
      if (e.target.classList.contains('btn-confirm')) return;
      if (e.target.classList.contains('payment-select')) return;
      toggleOrderDetail(row.getAttribute('data-id'), row);
    });
  });

  document.querySelectorAll('.btn-confirm').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('確定要讓此草稿生效嗎？生效後將計入庫存。')) {
        await confirmOrder(e.target.getAttribute('data-id'));
      }
    });
  });

  document.querySelectorAll('.payment-select').forEach(sel => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async (e) => {
      await updatePaymentStatus(e.target.getAttribute('data-id'), e.target.value);
    });
  });

  document.querySelectorAll('.btn-void').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('確定要作廢此單據嗎？庫存將會自動回沖。')) {
        await voidOrder(e.target.getAttribute('data-id'));
      }
    });
  });
}

async function toggleOrderDetail(orderId, rowElement) {
  const nextRow = rowElement.nextElementSibling;
  if (nextRow && nextRow.classList.contains('detail-row')) {
    nextRow.remove();
    return;
  }

  // Remove other open details
  document.querySelectorAll('.detail-row').forEach(el => el.remove());

  try {
    const { data, error } = await sb
      .from('order_items')
      .select('*, products(name, sku, unit)')
      .eq('order_id', orderId);
    
    if (error) throw error;

    const detailHtml = `
      <tr class="detail-row">
        <td colspan="9" style="padding: 1rem 2rem;">
          <table class="detail-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>數量</th>
                <th>單價</th>
                <th>折扣(%)</th>
                <th>小計</th>
              </tr>
            </thead>
            <tbody>
              ${data.map(item => `
                <tr>
                  <td>${item.products.name} <span class="text-muted">(${item.products.sku})</span></td>
                  <td>${Math.abs(item.qty)} ${item.products.unit}</td>
                  <td>${formatCurrency(item.unit_price)}</td>
                  <td>${item.discount}</td>
                  <td>${formatCurrency(item.subtotal)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </td>
      </tr>
    `;
    
    rowElement.insertAdjacentHTML('afterend', detailHtml);
  } catch (error) {
    showToast('載入明細失敗: ' + error.message, 'error');
  }
}

async function confirmOrder(orderId) {
  try {
    const { error } = await sb.rpc('confirm_order', { p_order_id: orderId });
    if (error) throw error;

    showToast('單據已確認生效', 'success');
    loadOrders();
  } catch (error) {
    showToast('確認失敗: ' + error.message, 'error');
  }
}

async function updatePaymentStatus(orderId, paymentStatus) {
  try {
    const { error } = await sb.from('orders')
      .update({ payment_status: paymentStatus })
      .eq('id', orderId);
    if (error) throw error;

    showToast('付款狀態已更新', 'success');
  } catch (error) {
    showToast('更新失敗: ' + error.message, 'error');
    loadOrders();
  }
}

async function voidOrder(orderId) {
  try {
    const { error } = await sb.rpc('void_order', { p_order_id: orderId });
    if (error) throw error;
    
    showToast('單據已作廢', 'success');
    loadOrders();
  } catch (error) {
    showToast('作廢失敗: ' + error.message, 'error');
  }
}

function updatePagination() {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  pageInfo.textContent = `第 ${currentPage} / ${totalPages} 頁 (共 ${totalCount} 筆)`;
  
  btnPrevPage.disabled = currentPage <= 1;
  btnNextPage.disabled = currentPage >= totalPages;
}

// --- Order Creation Modal Logic ---

function updatePartnerDropdown() {
  const type = document.getElementById('order-type').value;
  const select = document.getElementById('order-partner');
  
  let filtered = partnersCache;
  if (type === 'purchase') filtered = partnersCache.filter(p => p.type === 'supplier');
  if (type === 'sale') filtered = partnersCache.filter(p => p.type === 'customer');
  
  select.innerHTML = '<option value="">請選擇...</option>' + 
    filtered.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

function addLineItem() {
  const container = document.getElementById('order-lines');
  const rowId = Date.now().toString();
  
  const row = document.createElement('div');
  row.className = 'line-item-row';
  row.id = `line-${rowId}`;
  
  row.innerHTML = `
    <select class="form-control line-product" required>
      <option value="">選擇商品...</option>
      ${productsCache.map(p => `<option value="${p.id}" data-cost="${p.cost}" data-price="${p.price}" data-stock="${p.stock_qty}">${p.name} (庫存: ${p.stock_qty})</option>`).join('')}
    </select>
    <input type="number" class="form-control line-qty" min="1" value="1" required>
    <input type="number" class="form-control line-price" min="0" step="0.01" value="0" required>
    <input type="number" class="form-control line-discount" min="0" max="100" value="0">
    <div class="line-subtotal" style="padding: 0.5rem; font-weight: 500;">NT$ 0</div>
    <button type="button" class="btn btn-outline text-danger btn-remove-line" style="padding: 0.5rem;">✕</button>
  `;
  
  container.appendChild(row);
  
  // Attach events
  const productSelect = row.querySelector('.line-product');
  const qtyInput = row.querySelector('.line-qty');
  const priceInput = row.querySelector('.line-price');
  const discountInput = row.querySelector('.line-discount');
  
  productSelect.addEventListener('change', (e) => {
    const option = e.target.selectedOptions[0];
    if (!option.value) return;
    
    const type = document.getElementById('order-type').value;
    priceInput.value = type === 'purchase' ? option.dataset.cost : option.dataset.price;
    calculateTotal();
  });
  
  [qtyInput, priceInput, discountInput].forEach(input => {
    input.addEventListener('input', calculateTotal);
  });
  
  row.querySelector('.btn-remove-line').addEventListener('click', () => {
    row.remove();
    calculateTotal();
  });
}

function calculateTotal() {
  let total = 0;
  document.querySelectorAll('.line-item-row:not(.line-item-header)').forEach(row => {
    const qty = parseFloat(row.querySelector('.line-qty').value) || 0;
    const price = parseFloat(row.querySelector('.line-price').value) || 0;
    const discount = parseFloat(row.querySelector('.line-discount').value) || 0;
    
    const subtotal = qty * price * (1 - discount / 100);
    row.querySelector('.line-subtotal').textContent = formatCurrency(subtotal);
    total += subtotal;
  });
  
  const orderDiscount = parseFloat(document.getElementById('order-discount').value) || 0;
  const orderTax = parseFloat(document.getElementById('order-tax').value) || 0;
  
  const finalTotal = total - orderDiscount + orderTax;
  document.getElementById('order-total-display').textContent = formatCurrency(finalTotal);
}

async function saveOrder(status = 'confirmed') {
  const form = document.getElementById('order-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const type = document.getElementById('order-type').value;
  const partnerId = document.getElementById('order-partner').value;
  
  if (type !== 'adjust' && !partnerId) {
    showToast('請選擇往來對象', 'error');
    return;
  }

  const items = [];
  document.querySelectorAll('.line-item-row:not(.line-item-header)').forEach(row => {
    const productId = row.querySelector('.line-product').value;
    if (productId) {
      items.push({
        product_id: productId,
        qty: parseInt(row.querySelector('.line-qty').value) || 0,
        unit_price: parseFloat(row.querySelector('.line-price').value) || 0,
        discount: parseFloat(row.querySelector('.line-discount').value) || 0
      });
    }
  });

  if (items.length === 0) {
    showToast('請至少加入一項商品', 'error');
    return;
  }

  try {
    const { error } = await sb.rpc('create_order', {
      p_type: type,
      p_partner: partnerId || null,
      p_note: document.getElementById('order-note').value || null,
      p_items: items,
      p_order_date: document.getElementById('order-date').value,
      p_discount: parseFloat(document.getElementById('order-discount').value) || 0,
      p_tax: parseFloat(document.getElementById('order-tax').value) || 0,
      p_status: status
    });

    if (error) throw error;

    showToast(status === 'draft' ? '草稿已儲存' : '單據建立成功', 'success');
    closeModal('order-modal');
    loadOrders();
    // Refresh products cache for updated stock
    loadProductsCache();
  } catch (error) {
    console.error('Error creating order:', error);
    showToast('建立失敗: ' + error.message, 'error');
  }
}

function setupEventListeners() {
  // Search filters
  const reloadDebounced = debounce(() => {
    currentPage = 1;
    loadOrders();
  }, 300);

  [searchDateFrom, searchDateTo, searchType, searchStatus].forEach(el => {
    el.addEventListener('change', () => { currentPage = 1; loadOrders(); });
  });
  
  searchKeyword.addEventListener('input', reloadDebounced);

  // Quick ranges
  document.querySelectorAll('.quick-ranges button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const range = e.target.dataset.range;
      const today = new Date();
      let from = new Date();
      let to = new Date();

      if (range === 'today') {
        // already set
      } else if (range === 'thisWeek') {
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
        from.setDate(diff);
      } else if (range === 'thisMonth') {
        from = new Date(today.getFullYear(), today.getMonth(), 1);
      } else if (range === 'lastMonth') {
        from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        to = new Date(today.getFullYear(), today.getMonth(), 0);
      }

      searchDateFrom.value = from.toISOString().split('T')[0];
      searchDateTo.value = to.toISOString().split('T')[0];
      currentPage = 1;
      loadOrders();
    });
  });

  // Pagination
  btnPrevPage.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadOrders();
    }
  });

  btnNextPage.addEventListener('click', () => {
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage++;
      loadOrders();
    }
  });

  // Modal
  document.getElementById('btn-add-order').addEventListener('click', () => {
    document.getElementById('order-form').reset();
    document.getElementById('order-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('order-lines').innerHTML = '';
    document.getElementById('order-total-display').textContent = 'NT$ 0';
    updatePartnerDropdown();
    addLineItem();
    openModal('order-modal');
  });

  document.getElementById('order-type').addEventListener('change', () => {
    updatePartnerDropdown();
    // Update prices for existing lines
    document.querySelectorAll('.line-product').forEach(select => {
      select.dispatchEvent(new Event('change'));
    });
  });

  document.getElementById('btn-add-line').addEventListener('click', addLineItem);
  
  ['order-discount', 'order-tax'].forEach(id => {
    document.getElementById(id).addEventListener('input', calculateTotal);
  });

  document.getElementById('btn-save-order').addEventListener('click', () => saveOrder('confirmed'));
  document.getElementById('btn-save-draft').addEventListener('click', () => saveOrder('draft'));
}

document.addEventListener('DOMContentLoaded', init);
