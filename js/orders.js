import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce, onReady, renderPagination } from './ui.js';
import { PAGE_SIZE, formatCurrency, formatDate, toDateInputValue, dateRange, debounce, totalPages, escapeHtml } from './utils.js';

let currentPage = 1;
let totalCount = 0;
let currentOrders = [];
let productsCache = [];
let partnersCache = [];
let editingOrderId = null;
let editingOrderStatus = null;
let pendingAutoExpand = false;

// DOM Elements
const searchDateFrom = document.getElementById('search-date-from');
const searchDateTo = document.getElementById('search-date-to');
const searchType = document.getElementById('search-type');
const searchStatus = document.getElementById('search-status');
const searchPayment = document.getElementById('search-payment');
const searchKeyword = document.getElementById('search-keyword');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');

async function init() {
  // Parse URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  
  // Set default date range (last 30 days) if not in URL
  const defaultRange = dateRange('last30Days');
  const hashParams = new URLSearchParams(window.location.hash.slice(1));

  searchDateTo.value = urlParams.get('to') || defaultRange.to;
  searchDateFrom.value = urlParams.get('from') || defaultRange.from;
  searchType.value = urlParams.get('type') || 'all';
  searchStatus.value = urlParams.get('status') || hashParams.get('status') || 'active';
  searchPayment.value = urlParams.get('payment') || hashParams.get('payment') || 'all';
  searchKeyword.value = urlParams.get('q') || hashParams.get('q') || '';
  currentPage = parseInt(urlParams.get('page')) || 1;
  pendingAutoExpand = urlParams.get('expand') === '1';

  document.getElementById('order-date').value = toDateInputValue(new Date());

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
  if (searchPayment.value !== 'all') urlParams.set('payment', searchPayment.value);
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

    // 付款狀態是推導值（order_search_view 直接輸出 order_payment_summary_view 的結果），
    // 因此能下推成 SQL 條件，不必把資料撈回瀏覽器過濾，伺服器端分頁與 count 才會正確。
    // view 對「非已確認出貨單」給 null，所以下了條件就自動排除進貨／調整／草稿／作廢單。
    if (searchPayment.value === 'outstanding') {
      query = query.in('payment_status', ['unpaid', 'partial']);
    } else if (searchPayment.value !== 'all') {
      query = query.eq('payment_status', searchPayment.value);
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
    autoExpandSingleResult();
  } catch (error) {
    console.error('Error loading orders:', error);
    showToast('載入單據失敗: ' + error.message, 'error');
  }
}

// 只在命中單筆時展開：q 是對 search_text 模糊比對，也會命中備註等欄位，
// 多筆全開會把使用者真正要看的那張單淹沒。
// 旗標用後即清，否則之後每次改搜尋條件都會再自己彈開一次。
function autoExpandSingleResult() {
  if (!pendingAutoExpand) return;
  pendingAutoExpand = false;

  if (currentOrders.length !== 1) return;

  const row = document.querySelector('#orders-table .clickable-row');
  if (row) toggleOrderDetail(row.getAttribute('data-id'), row);
}

function renderOrdersTable() {
  const tbody = document.querySelector('#orders-table tbody');
  if (currentOrders.length === 0) {
    // 從收款頁的沖帳明細跳來卻撲空，多半是單號被改過或該單已不存在，
    // 只寫「找不到單據」會讓人以為連結壞了。
    const hint = pendingAutoExpand
      ? `<div class="text-muted" style="font-size: 0.85rem; margin-top: 0.5rem;">
           找不到單號 ${escapeHtml(searchKeyword.value)}，該單據可能已被刪除或單號已變更。
         </div>`
      : '';
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">找不到單據${hint}</td></tr>`;
    return;
  }

  const typeMap = {
    'purchase': '<span class="badge badge-blue">進貨</span>',
    'sale': '<span class="badge badge-green">出貨</span>',
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

  // 付款狀態由收款紀錄推導（order_payment_summary_view），不可直接編輯。
  // 點擊導向收款管理並帶 order_id，讓使用者直接看到／建立對應的收款。
  const paymentLink = (order) => {
    const label = paymentMap[order.payment_status] || paymentMap['unpaid'];
    const paid = Number(order.paid_amount || 0);
    const detail = order.payment_status === 'partial'
      ? `<span class="text-muted" style="font-size: 0.8rem; display: block;">已收 ${formatCurrency(paid)}</span>`
      : '';
    return `
      <a href="payments.html?order_id=${encodeURIComponent(order.id)}" class="payment-link"
         title="查看此單據的收款紀錄">${label}${detail}</a>`;
  };

  tbody.innerHTML = currentOrders.map(order => `
    <tr class="clickable-row" data-id="${order.id}">
      <td>${formatDate(order.order_date)}</td>
      <td>${escapeHtml(order.order_no)}</td>
      <td>${typeMap[order.type]}</td>
      <td>${statusMap[order.status]}</td>
      <td>${escapeHtml(order.partner_name || '-')}</td>
      <td>${order.item_count}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(order.total_amount)}</td>
      <td>${order.type === 'sale' && order.status === 'confirmed' ? paymentLink(order) : '-'}</td>
      <td>
        ${order.status === 'draft' ?
          `<button class="btn btn-outline btn-edit" data-id="${order.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">編輯</button>
           <button class="btn btn-primary btn-confirm" data-id="${order.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">確認</button> ` :
          ''}
        ${order.status === 'confirmed' ?
          `<button class="btn btn-outline btn-edit" data-id="${order.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">編輯</button> ` :
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
      if (e.target.classList.contains('btn-edit')) return;
      if (e.target.closest('.payment-link')) return;
      toggleOrderDetail(row.getAttribute('data-id'), row);
    });
  });

  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditOrder(e.target.getAttribute('data-id'));
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
    rowElement.classList.remove('detail-open');
    return;
  }

  // 明細是非同步載入，連點時第二次會在插入前就進來，
  // 因此用同步標記判定展開狀態，避免重複插入 detail-row。
  if (rowElement.classList.contains('detail-open')) {
    rowElement.classList.remove('detail-open');
    return;
  }

  document.querySelectorAll('.detail-row').forEach(el => el.remove());
  document.querySelectorAll('.detail-open').forEach(el => el.classList.remove('detail-open'));
  rowElement.classList.add('detail-open');

  try {
    const { data, error } = await sb
      .from('order_items')
      .select('*, products(name, sku, spec, unit)')
      .eq('order_id', orderId);
    
    if (error) throw error;

    const order = currentOrders.find(o => o.id === orderId);
    const isSale = order && order.type === 'sale';

    const detailHtml = `
      <tr class="detail-row">
        <td colspan="9" style="padding: 1rem 2rem;">
          <div class="d-flex justify-between align-center mb-2">
            <h4 style="margin: 0;">單據明細</h4>
            ${isSale ? `<button class="btn btn-outline btn-print-shipping" data-id="${orderId}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">列印出貨單</button>` : ''}
          </div>
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
                  <td>${escapeHtml(item.products.name)} <span class="text-muted">(${escapeHtml(item.products.sku)})</span></td>
                  <td>${Math.abs(item.qty)} ${escapeHtml(item.products.unit)}</td>
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

    if (isSale) {
      const printBtn = rowElement.nextElementSibling.querySelector('.btn-print-shipping');
      if (printBtn) {
        printBtn.addEventListener('click', () => printShippingOrder(order, data));
      }
    }
  } catch (error) {
    rowElement.classList.remove('detail-open');
    showToast('載入明細失敗：' + toErrorMessage(error), 'error');
  }
}

async function printShippingOrder(order, items) {
  const printArea = document.getElementById('print-area');

  let partner = null;
  if (order.partner_id) {
    const { data } = await sb.from('partners').select('*').eq('id', order.partner_id).single();
    partner = data;
  }

  printArea.innerHTML = `
    <div class="print-doc-header">
      <h1>藝境裝潢材料行</h1>
      <h2>出貨單</h2>
    </div>
    <div class="print-info-box">
      <div>
        <p><strong>客戶編號：</strong>${escapeHtml(partner?.partner_no || '')}</p>
        <p><strong>客戶名稱：</strong>${escapeHtml(order.partner_name || '')}</p>
        <p><strong>統一編號：</strong>${escapeHtml(partner?.tax_id || '')}</p>
      </div>
      <div>
        <p><strong>單號：</strong>${escapeHtml(order.order_no)}</p>
        <p><strong>出貨日期：</strong>${formatDate(order.order_date)}</p>
        <p><strong>聯絡電話：</strong>${escapeHtml(partner?.phone || '')}</p>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>品名</th>
          <th>規格</th>
          <th>數量</th>
          <th>單位</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td>${escapeHtml(item.products.name)}</td>
            <td>${escapeHtml(item.products.spec || '')}</td>
            <td>${Math.abs(item.qty)}</td>
            <td>${escapeHtml(item.products.unit || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="print-footer">
      <div>
        客戶簽收：<span class="signature-line"></span>
      </div>
    </div>
  `;

  window.print();
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
  renderPagination({ page: currentPage, total: totalCount, pageSize: PAGE_SIZE });
}

// --- Order Creation Modal Logic ---

function updatePartnerDropdown() {
  const type = document.getElementById('order-type').value;
  const select = document.getElementById('order-partner');
  
  let filtered = partnersCache;
  if (type === 'purchase') filtered = partnersCache.filter(p => p.type === 'supplier');
  if (type === 'sale') filtered = partnersCache.filter(p => p.type === 'customer');
  
  select.innerHTML = '<option value="">請選擇...</option>' + 
    filtered.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
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
      ${productsCache.map(p => `<option value="${escapeHtml(p.id)}" data-cost="${escapeHtml(p.cost)}" data-price="${escapeHtml(p.price)}" data-stock="${escapeHtml(p.stock_qty)}" data-spec="${escapeHtml(p.spec || '')}" data-unit="${escapeHtml(p.unit || '')}">${escapeHtml(p.name)} (庫存: ${escapeHtml(p.stock_qty)})</option>`).join('')}
    </select>
    <div class="line-spec-unit text-muted" style="font-size: 0.9rem; padding: 0.5rem;">-</div>
    <input type="number" class="form-control line-qty" min="1" value="1" required>
    <input type="number" class="form-control line-price price-col" min="0" step="0.01" value="0" required>
    <input type="number" class="form-control line-discount price-col" min="0" max="100" value="0">
    <div class="line-subtotal price-col" style="padding: 0.5rem; font-weight: 500;">NT$ 0</div>
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
    if (!option.value) {
      row.querySelector('.line-spec-unit').textContent = '-';
      return;
    }
    
    const spec = option.dataset.spec;
    const unit = option.dataset.unit;
    row.querySelector('.line-spec-unit').textContent = [spec, unit].filter(Boolean).join(' / ') || '-';
    
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

function setOrderModalMode(mode) {
  const isCreate = mode === 'create';
  const isDraft = mode === 'draft';
  const isConfirmed = mode === 'confirmed';

  const titles = { create: '新增單據', draft: '編輯草稿', confirmed: '編輯單據' };
  document.getElementById('order-modal-title').textContent = titles[mode];

  // 類型鎖定：切換 purchase/sale 會翻轉既有明細的正負號語意，
  // 要改型別應作廢重開，而非就地修改。
  document.getElementById('order-type').disabled = !isCreate;

  // 已確認單據只開放備註；改動明細或金額等同改寫已生效的庫存與帳務。
  const headerLocked = isConfirmed;
  ['order-date', 'order-partner', 'order-discount', 'order-tax'].forEach(id => {
    document.getElementById(id).disabled = headerLocked;
  });

  document.getElementById('btn-add-line').style.display = headerLocked ? 'none' : '';
  document.getElementById('order-lines').classList.toggle('lines-readonly', headerLocked);
  document.getElementById('confirmed-edit-hint').hidden = !isConfirmed;

  const btnSaveOrder = document.getElementById('btn-save-order');
  const btnSaveDraft = document.getElementById('btn-save-draft');

  // 用 display 而非 hidden 屬性：.btn 的 display 宣告會蓋過 [hidden]。
  btnSaveDraft.style.display = isConfirmed ? 'none' : '';
  btnSaveOrder.textContent = isCreate ? '建立單據' : (isDraft ? '儲存並確認' : '儲存');
  if (isDraft) btnSaveDraft.textContent = '儲存草稿';
  if (isCreate) btnSaveDraft.textContent = '存為草稿';
}

function setLineItemsReadonly(readonly) {
  document.querySelectorAll('#order-lines .line-item-row').forEach(row => {
    row.querySelectorAll('select, input').forEach(el => { el.disabled = readonly; });
    const removeBtn = row.querySelector('.btn-remove-line');
    if (removeBtn) removeBtn.style.display = readonly ? 'none' : '';
  });
}

async function openEditOrder(orderId) {
  const order = currentOrders.find(o => o.id === orderId);
  if (!order) return;

  if (order.status === 'void') {
    showToast('已作廢的單據無法編輯', 'error');
    return;
  }

  try {
    const { data: items, error } = await sb
      .from('order_items')
      .select('*')
      .eq('order_id', orderId);
    if (error) throw error;

    editingOrderId = orderId;
    editingOrderStatus = order.status;

    const form = document.getElementById('order-form');
    form.reset();
    document.getElementById('order-lines').innerHTML = '';

    document.getElementById('order-type').value = order.type;
    document.getElementById('order-date').value = order.order_date;
    document.getElementById('order-note').value = order.note || '';
    document.getElementById('order-discount').value = order.discount || 0;
    document.getElementById('order-tax').value = order.tax || 0;

    const modal = document.getElementById('order-modal');
    modal.classList.toggle('hide-prices', order.type === 'sale');

    updatePartnerDropdown();
    document.getElementById('order-partner').value = order.partner_id || '';

    items.forEach(item => {
      addLineItem();
      const row = document.getElementById('order-lines').lastElementChild;
      row.querySelector('.line-product').value = item.product_id;
      row.querySelector('.line-product').dispatchEvent(new Event('change'));
      row.querySelector('.line-qty').value = order.type === 'adjust' ? item.qty : Math.abs(item.qty);
      row.querySelector('.line-price').value = item.unit_price;
      row.querySelector('.line-discount').value = item.discount || 0;
    });

    if (items.length === 0) addLineItem();

    calculateTotal();
    setOrderModalMode(order.status === 'draft' ? 'draft' : 'confirmed');
    setLineItemsReadonly(order.status === 'confirmed');
    openModal('order-modal');
  } catch (error) {
    console.error('Error loading order for edit:', error);
    showToast('載入單據失敗：' + toErrorMessage(error), 'error');
  }
}

async function saveConfirmedOrderNote() {
  try {
    const { error } = await sb.rpc('update_order_meta', {
      p_order_id: editingOrderId,
      p_note: document.getElementById('order-note').value || ''
    });
    if (error) throw error;

    showToast('備註已更新', 'success');
    closeModal('order-modal');
    editingOrderId = null;
    editingOrderStatus = null;
    loadOrders();
  } catch (error) {
    console.error('Error updating note:', error);
    showToast('更新失敗：' + toErrorMessage(error), 'error');
  }
}

async function saveOrder(status = 'confirmed') {
  // 已確認單據的表頭與明細欄位皆為 disabled，僅備註可改，
  // 直接走 meta 更新以免誤用整張替換的 RPC。
  if (editingOrderId && editingOrderStatus === 'confirmed') {
    await saveConfirmedOrderNote();
    return;
  }

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

  const common = {
    p_partner: partnerId || null,
    p_note: document.getElementById('order-note').value || null,
    p_items: items,
    p_order_date: document.getElementById('order-date').value,
    p_discount: parseFloat(document.getElementById('order-discount').value) || 0,
    p_tax: parseFloat(document.getElementById('order-tax').value) || 0
  };

  try {
    if (editingOrderId) {
      const { error } = await sb.rpc('update_draft_order', {
        p_order_id: editingOrderId,
        ...common
      });
      if (error) throw error;

      if (status === 'confirmed') {
        const { error: confirmError } = await sb.rpc('confirm_order', { p_order_id: editingOrderId });
        if (confirmError) throw confirmError;
      }
      showToast(status === 'draft' ? '草稿已更新' : '單據已確認', 'success');
    } else {
      const { error } = await sb.rpc('create_order', {
        p_type: type,
        ...common,
        p_status: status
      });
      if (error) throw error;

      showToast(status === 'draft' ? '草稿已儲存' : '單據建立成功', 'success');
    }

    closeModal('order-modal');
    editingOrderId = null;
    editingOrderStatus = null;
    loadOrders();
    // Refresh products cache for updated stock
    loadProductsCache();
  } catch (error) {
    console.error('Error saving order:', error);
    showToast('儲存失敗：' + toErrorMessage(error), 'error');
  }
}

function setupEventListeners() {
  // Search filters
  const reloadDebounced = debounce(() => {
    currentPage = 1;
    loadOrders();
  }, 300);

  [searchDateFrom, searchDateTo, searchType, searchStatus, searchPayment].forEach(el => {
    el.addEventListener('change', () => { currentPage = 1; loadOrders(); });
  });
  
  searchKeyword.addEventListener('input', reloadDebounced);

  // Quick ranges
  document.querySelectorAll('.quick-ranges button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const { from, to } = dateRange(e.target.dataset.range);
      searchDateFrom.value = from;
      searchDateTo.value = to;
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
    if (currentPage < totalPages(totalCount)) {
      currentPage++;
      loadOrders();
    }
  });

  // Modal
  document.getElementById('btn-add-order').addEventListener('click', () => {
    editingOrderId = null;
    editingOrderStatus = null;
    setOrderModalMode('create');
    document.getElementById('order-form').reset();
    document.getElementById('order-date').value = toDateInputValue(new Date());
    document.getElementById('order-lines').innerHTML = '';
    document.getElementById('order-total-display').textContent = 'NT$ 0';
    
    const type = document.getElementById('order-type').value;
    const modal = document.getElementById('order-modal');
    if (type === 'sale') {
      modal.classList.add('hide-prices');
    } else {
      modal.classList.remove('hide-prices');
    }
    
    updatePartnerDropdown();
    addLineItem();
    openModal('order-modal');
  });

  document.getElementById('order-type').addEventListener('change', (e) => {
    const type = e.target.value;
    const modal = document.getElementById('order-modal');
    if (type === 'sale') {
      modal.classList.add('hide-prices');
    } else {
      modal.classList.remove('hide-prices');
    }
    
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

  bindSubmitOnce('btn-save-order', () => saveOrder('confirmed'));
  bindSubmitOnce('btn-save-draft', () => saveOrder('draft'));
}

onReady(init);
