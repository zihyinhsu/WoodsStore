import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce, onReady, renderPagination } from './ui.js';
import { PAGE_SIZE, formatCurrency, formatDate, toDateInputValue, debounce, round2, totalPages, escapeHtml } from './utils.js';

let currentPage = 1;
let totalCount = 0;
let currentPayments = [];
let partnersCache = [];
let balanceCache = [];
let orderFilterId = null;
let orderFilterNo = null;

const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const paymentPartner = document.getElementById('payment-partner');
const paymentOrdersList = document.getElementById('payment-orders-list');
const paymentAmount = document.getElementById('payment-amount');
const allocatedTotal = document.getElementById('allocated-total');
const unallocatedHint = document.getElementById('unallocated-hint');
const partnerBalanceHint = document.getElementById('partner-balance-hint');
const btnAutoAllocate = document.getElementById('btn-auto-allocate');
const orderFilterNotice = document.getElementById('order-filter-notice');

const searchDateFrom = document.getElementById('search-date-from');
const searchDateTo = document.getElementById('search-date-to');
const searchPartner = document.getElementById('search-partner');
const searchMethod = document.getElementById('search-method');
const searchKeyword = document.getElementById('search-keyword');
const btnResetSearch = document.getElementById('btn-reset-search');

const methodMap = {
  'cash': '現金',
  'transfer': '匯款',
  'check': '支票'
};

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  orderFilterId = urlParams.get('order_id');
  if (orderFilterId) await loadOrderFilterNo();

  searchDateFrom.value = urlParams.get('from') || '';
  searchDateTo.value = urlParams.get('to') || '';
  searchPartner.value = urlParams.get('partner') || 'all';
  searchMethod.value = urlParams.get('method') || 'all';
  searchKeyword.value = urlParams.get('q') || '';
  currentPage = parseInt(urlParams.get('page')) || 1;

  await loadPartnersCache();
  await Promise.all([loadBalances(), loadPayments()]);

  setupEventListeners();
}

async function loadPartnersCache() {
  const { data } = await sb.from('partners').select('*').eq('type', 'customer').order('partner_no');
  partnersCache = data || [];

  const options = partnersCache.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  paymentPartner.innerHTML = '<option value="">請選擇...</option>' + options;

  const keepSelected = searchPartner.value;
  searchPartner.innerHTML = '<option value="all">全部</option>' + options;
  searchPartner.value = keepSelected || 'all';
}

async function loadBalances() {
  try {
    const { data, error } = await sb.from('partner_balance_view').select('*').order('partner_no');
    if (error) throw error;

    balanceCache = data || [];

    const tbody = document.querySelector('#balance-table tbody');
    if (balanceCache.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">無客戶資料</td></tr>';
      return;
    }

    tbody.innerHTML = balanceCache.map(b => `
      <tr>
        <td>${escapeHtml(b.partner_no || '-')}</td>
        <td>${escapeHtml(b.name)}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_sales)}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_paid)}</td>
        <td style="font-family: 'Roboto', sans-serif;" class="${Number(b.unallocated_credit) > 0 ? 'text-warning' : 'text-muted'}">
          ${formatCurrency(b.unallocated_credit)}
        </td>
        <td class="balance-amount ${Number(b.balance) > 0 ? 'positive' : ''}" style="font-family: 'Roboto', sans-serif;">
          ${formatCurrency(b.balance)}
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Error loading balances:', error);
    showToast('載入餘額失敗：' + toErrorMessage(error), 'error');
  }
}

function updateUrlParams() {
  const urlParams = new URLSearchParams();
  if (orderFilterId) urlParams.set('order_id', orderFilterId);
  if (searchDateFrom.value) urlParams.set('from', searchDateFrom.value);
  if (searchDateTo.value) urlParams.set('to', searchDateTo.value);
  if (searchPartner.value !== 'all') urlParams.set('partner', searchPartner.value);
  if (searchMethod.value !== 'all') urlParams.set('method', searchMethod.value);
  if (searchKeyword.value) urlParams.set('q', searchKeyword.value);
  if (currentPage > 1) urlParams.set('page', currentPage);

  const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
  window.history.replaceState({}, '', newUrl);
}

async function loadOrderFilterNo() {
  try {
    const { data, error } = await sb.from('order_search_view')
      .select('order_no')
      .eq('id', orderFilterId)
      .single();
    if (error) throw error;
    orderFilterNo = data?.order_no || null;
  } catch (error) {
    console.error('Error loading filtered order:', error);
    orderFilterNo = null;
  }
}

function renderOrderFilterNotice() {
  if (!orderFilterId) {
    orderFilterNotice.style.display = 'none';
    orderFilterNotice.innerHTML = '';
    return;
  }

  const label = orderFilterNo ? `單號 ${escapeHtml(orderFilterNo)}` : '指定單據';

  orderFilterNotice.style.display = '';
  orderFilterNotice.innerHTML = `
    <div class="d-flex justify-between align-center" style="border: 2px solid var(--border-color); padding: 0.5rem 1rem; background: var(--bg-page);">
      <span>目前僅顯示<strong>${label}</strong>的收款紀錄</span>
      <button class="btn btn-outline" id="btn-clear-order-filter" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">顯示全部</button>
    </div>`;

  document.getElementById('btn-clear-order-filter').addEventListener('click', () => {
    orderFilterId = null;
    orderFilterNo = null;
    currentPage = 1;
    loadPayments();
  });
}

async function loadPayments() {
  updateUrlParams();
  try {
    const from = (currentPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = sb.from('payment_search_view').select('*', { count: 'exact' });

    if (orderFilterId) query = query.contains('order_ids', [orderFilterId]);
    if (searchDateFrom.value) query = query.gte('payment_date', searchDateFrom.value);
    if (searchDateTo.value) query = query.lte('payment_date', searchDateTo.value);
    if (searchPartner.value !== 'all') query = query.eq('partner_id', searchPartner.value);
    if (searchMethod.value !== 'all') query = query.eq('method', searchMethod.value);
    if (searchKeyword.value) query = query.ilike('search_text', `%${searchKeyword.value}%`);

    const { data, count, error } = await query
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    currentPayments = data || [];
    totalCount = count || 0;

    renderPaymentsTable();
    renderOrderFilterNotice();
    updatePagination();
  } catch (error) {
    console.error('Error loading payments:', error);
    showToast('載入收款紀錄失敗：' + toErrorMessage(error), 'error');
  }
}

function renderPaymentsTable() {
  const tbody = document.querySelector('#payments-table tbody');
  if (currentPayments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">找不到收款紀錄</td></tr>';
    return;
  }

  tbody.innerHTML = currentPayments.map(p => {
    const unallocated = Number(p.unallocated_amount) || 0;
    return `
    <tr>
      <td>${formatDate(p.payment_date)}</td>
      <td>${escapeHtml(p.payment_no)}</td>
      <td>${escapeHtml(p.partner_name || '-')}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.amount)}</td>
      <td style="font-family: 'Roboto', sans-serif;">
        ${formatCurrency(p.allocated_amount)}
        ${unallocated > 0 ? `<span class="text-warning" style="font-size: 0.8rem; display: block;">未分配 ${formatCurrency(unallocated)}</span>` : ''}
      </td>
      <td>${methodMap[p.method] || escapeHtml(p.method)}</td>
      <td>${escapeHtml(p.note || '-')}</td>
      <td>
        <button class="btn btn-outline btn-edit-payment" data-id="${p.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">編輯</button>
        <button class="btn btn-outline btn-print" data-id="${p.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">列印</button>
        <button class="btn btn-outline btn-delete-payment" data-id="${p.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; color: var(--danger);">刪除</button>
      </td>
    </tr>`;
  }).join('');

  document.querySelectorAll('.btn-print').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const payment = currentPayments.find(p => p.id === e.target.getAttribute('data-id'));
      if (payment) printPayment(payment);
    });
  });

  document.querySelectorAll('.btn-edit-payment').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const payment = currentPayments.find(p => p.id === e.target.getAttribute('data-id'));
      if (payment) openPaymentModal(payment);
    });
  });

  document.querySelectorAll('.btn-delete-payment').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const payment = currentPayments.find(p => p.id === e.target.getAttribute('data-id'));
      if (!payment) return;

      if (confirm(`確定要刪除收款單 ${payment.payment_no}（${formatCurrency(payment.amount)}）嗎？\n刪除後相關單據的付款狀態會一併回復。`)) {
        await deletePayment(payment.id);
      }
    });
  });
}

function renderPartnerBalanceHint(partnerId) {
  if (!partnerId) {
    partnerBalanceHint.style.display = 'none';
    partnerBalanceHint.innerHTML = '';
    return;
  }

  const balance = balanceCache.find(b => b.id === partnerId);
  if (!balance) {
    partnerBalanceHint.style.display = 'none';
    return;
  }

  const credit = Number(balance.unallocated_credit) || 0;
  partnerBalanceHint.style.display = '';
  partnerBalanceHint.innerHTML = `
    <span class="text-muted">目前應收餘額：</span>
    <strong class="${Number(balance.balance) > 0 ? 'text-danger' : 'text-success'}"
            style="font-family: 'Roboto', sans-serif;">${formatCurrency(balance.balance)}</strong>
    ${credit > 0 ? `<span class="text-warning" style="margin-left: 0.5rem;">未分配預收 ${formatCurrency(credit)}</span>` : ''}`;
}

async function loadAllocatableOrders(partnerId, paymentId = null) {
  if (!partnerId) {
    paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">請先選擇客戶</div>';
    updateAllocatedTotal();
    return;
  }

  paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">載入中...</div>';

  try {
    const [outstandingRes, existingRes] = await Promise.all([
      sb.from('outstanding_order_view').select('*').eq('partner_id', partnerId).order('order_date'),
      paymentId
        ? sb.from('payment_allocation_view').select('*').eq('payment_id', paymentId).order('order_date')
        : Promise.resolve({ data: [], error: null })
    ]);

    if (outstandingRes.error) throw outstandingRes.error;
    if (existingRes.error) throw existingRes.error;

    const existing = existingRes.data || [];
    const existingById = new Map(existing.map(e => [e.order_id, e]));

    // 編輯時，這筆收款自己已分配的金額會讓單據看起來未收較少，
    // 必須加回去才是「這筆收款可以動用的上限」，否則改金額時會被自己卡住。
    const rows = (outstandingRes.data || []).map(o => {
      const mine = Number(existingById.get(o.id)?.allocated_amount) || 0;
      return {
        id: o.id,
        order_no: o.order_no,
        order_date: o.order_date,
        order_total: Number(o.order_total),
        allocatable: round2(Number(o.outstanding_amount) + mine),
        allocated: mine
      };
    });

    existing.forEach(e => {
      if (rows.some(r => r.id === e.order_id)) return;
      rows.push({
        id: e.order_id,
        order_no: e.order_no,
        order_date: e.order_date,
        order_total: Number(e.order_total),
        allocatable: round2(Number(e.allocated_amount)),
        allocated: Number(e.allocated_amount)
      });
    });

    if (rows.length === 0) {
      paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">此客戶目前沒有未收款的出貨單</div>';
      updateAllocatedTotal();
      return;
    }

    rows.sort((a, b) => (a.order_date < b.order_date ? -1 : a.order_date > b.order_date ? 1 : 0));

    paymentOrdersList.innerHTML = rows.map(r => `
      <div class="allocation-row" data-id="${escapeHtml(r.id)}" data-allocatable="${escapeHtml(r.allocatable)}"
           style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; border-bottom: 1px solid var(--border-light);">
        <input type="checkbox" class="order-checkbox" ${r.allocated > 0 ? 'checked' : ''}>
        <span style="flex: 1;">
          ${formatDate(r.order_date)} - ${escapeHtml(r.order_no)}
          <span class="text-muted" style="font-size: 0.8rem; display: block;">
            單據 ${formatCurrency(r.order_total)}／可沖 ${formatCurrency(r.allocatable)}
          </span>
        </span>
        <input type="number" class="form-control allocation-amount" min="0" step="0.01"
               max="${r.allocatable}" value="${r.allocated > 0 ? r.allocated : ''}"
               ${r.allocated > 0 ? '' : 'disabled'}
               style="width: 120px; font-family: 'Roboto', sans-serif; text-align: right;">
      </div>
    `).join('');

    bindAllocationEvents();
    updateAllocatedTotal();
  } catch (error) {
    console.error('Error loading orders:', error);
    paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0; color: var(--danger);">載入失敗</div>';
    showToast('載入出貨單失敗：' + toErrorMessage(error), 'error');
  }
}

function bindAllocationEvents() {
  document.querySelectorAll('.allocation-row').forEach(row => {
    const checkbox = row.querySelector('.order-checkbox');
    const input = row.querySelector('.allocation-amount');
    const allocatable = Number(row.getAttribute('data-allocatable'));

    checkbox.addEventListener('change', () => {
      input.disabled = !checkbox.checked;
      if (checkbox.checked) {
        input.value = remainingAllocatable(allocatable);
      } else {
        input.value = '';
      }
      updateAllocatedTotal();
    });

    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (value > allocatable) input.value = allocatable;
      updateAllocatedTotal();
    });
  });
}

// 勾選時預設帶入「這張單還能沖多少」與「這筆收款還剩多少沒分配」的較小值，
// 讓整張結清成為單純打勾即可完成的預設路徑。
function remainingAllocatable(allocatable) {
  const total = Number(paymentAmount.value) || 0;
  if (total <= 0) return allocatable;

  let used = 0;
  document.querySelectorAll('.allocation-row').forEach(row => {
    const input = row.querySelector('.allocation-amount');
    if (!input.disabled) used += Number(input.value) || 0;
  });

  return round2(Math.max(Math.min(allocatable, total - used), 0));
}

function updateAllocatedTotal() {
  let total = 0;
  document.querySelectorAll('.allocation-row').forEach(row => {
    const input = row.querySelector('.allocation-amount');
    if (!input.disabled) total += Number(input.value) || 0;
  });

  total = round2(total);
  allocatedTotal.textContent = formatCurrency(total);
  allocatedTotal.setAttribute('data-value', total);

  const paid = Number(paymentAmount.value) || 0;
  const diff = round2(paid - total);

  if (paid <= 0) {
    unallocatedHint.textContent = '';
    unallocatedHint.className = 'text-muted';
  } else if (diff > 0) {
    unallocatedHint.textContent = `未分配 ${formatCurrency(diff)}（列為預收）`;
    unallocatedHint.className = 'text-warning';
  } else if (diff < 0) {
    unallocatedHint.textContent = `超出收款金額 ${formatCurrency(-diff)}`;
    unallocatedHint.className = 'text-danger';
  } else {
    unallocatedHint.textContent = '已全數分配';
    unallocatedHint.className = 'text-success';
  }
}

function autoAllocate() {
  const total = Number(paymentAmount.value) || 0;
  if (total <= 0) {
    showToast('請先填寫收款金額', 'error');
    return;
  }

  let remaining = total;
  document.querySelectorAll('.allocation-row').forEach(row => {
    const checkbox = row.querySelector('.order-checkbox');
    const input = row.querySelector('.allocation-amount');
    const allocatable = Number(row.getAttribute('data-allocatable'));

    const give = round2(Math.min(allocatable, remaining));
    if (give > 0) {
      checkbox.checked = true;
      input.disabled = false;
      input.value = give;
      remaining = round2(remaining - give);
    } else {
      checkbox.checked = false;
      input.disabled = true;
      input.value = '';
    }
  });

  updateAllocatedTotal();
}

function collectAllocations() {
  const allocations = [];
  document.querySelectorAll('.allocation-row').forEach(row => {
    const input = row.querySelector('.allocation-amount');
    if (input.disabled) return;

    const amount = round2(Number(input.value));
    if (amount > 0) {
      allocations.push({ order_id: row.getAttribute('data-id'), amount });
    }
  });
  return allocations;
}

function openPaymentModal(payment = null) {
  const form = document.getElementById('payment-form');
  form.reset();
  document.getElementById('payment-date').value = toDateInputValue(new Date());
  paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">請先選擇客戶</div>';
  partnerBalanceHint.style.display = 'none';
  updateAllocatedTotal();

  if (payment) {
    document.getElementById('payment-modal-title').textContent = '編輯收款';
    document.getElementById('payment-id').value = payment.id;
    paymentPartner.value = payment.partner_id;
    document.getElementById('payment-date').value = payment.payment_date;
    paymentAmount.value = payment.amount;
    document.getElementById('payment-method').value = payment.method;
    document.getElementById('payment-note').value = payment.note || '';
    renderPartnerBalanceHint(payment.partner_id);
    loadAllocatableOrders(payment.partner_id, payment.id);
  } else {
    document.getElementById('payment-modal-title').textContent = '新增收款';
    document.getElementById('payment-id').value = '';
  }

  openModal('payment-modal');
}

async function deletePayment(id) {
  try {
    const { error } = await sb.from('payments').delete().eq('id', id);
    if (error) throw error;

    showToast('收款紀錄已刪除', 'success');
    await Promise.all([loadBalances(), loadPayments()]);
  } catch (error) {
    console.error('Error deleting payment:', error);
    showToast('刪除失敗：' + toErrorMessage(error), 'error');
  }
}

async function savePayment() {
  const form = document.getElementById('payment-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const amount = round2(Number(paymentAmount.value));
  const allocations = collectAllocations();
  const allocatedSum = round2(allocations.reduce((sum, a) => sum + a.amount, 0));

  if (allocatedSum > amount) {
    showToast(`分配總額 ${formatCurrency(allocatedSum)} 超過收款金額 ${formatCurrency(amount)}`, 'error');
    return;
  }

  const id = document.getElementById('payment-id').value;

  try {
    const { error } = await sb.rpc('save_payment_with_allocations', {
      p_partner_id: paymentPartner.value,
      p_payment_date: document.getElementById('payment-date').value,
      p_amount: amount,
      p_method: document.getElementById('payment-method').value,
      p_note: document.getElementById('payment-note').value || null,
      p_allocations: allocations,
      p_payment_id: id || null
    });

    if (error) throw error;

    showToast(id ? '收款紀錄已更新' : '收款紀錄已儲存', 'success');
    closeModal('payment-modal');

    currentPage = 1;
    await Promise.all([loadBalances(), loadPayments()]);
  } catch (error) {
    console.error('Error saving payment:', error);
    showToast('儲存失敗：' + toErrorMessage(error), 'error');
  }
}

async function printPayment(payment) {
  const printArea = document.getElementById('print-area');

  let partner = null;
  let balance = null;
  let lineItems = [];

  try {
    const [partnerRes, balanceRes, linksRes] = await Promise.all([
      sb.from('partners').select('*').eq('id', payment.partner_id).single(),
      sb.from('partner_balance_view').select('balance').eq('id', payment.partner_id).single(),
      sb.from('payment_orders').select('order_id').eq('payment_id', payment.id)
    ]);

    if (partnerRes.error) throw partnerRes.error;
    if (linksRes.error) throw linksRes.error;
    if (balanceRes.error && balanceRes.error.code !== 'PGRST116') {
      console.warn('Error loading balance:', balanceRes.error);
    }

    partner = partnerRes.data;
    balance = balanceRes.data?.balance;

    const linkedOrderIds = (linksRes.data || []).map(l => l.order_id);
    if (linkedOrderIds.length > 0) {
      const { data: lines, error: linesErr } = await sb.from('statement_line_view')
        .select('*')
        .in('order_id', linkedOrderIds)
        .order('order_date');
      if (linesErr) throw linesErr;
      lineItems = lines || [];
    }
  } catch (error) {
    console.error('Error loading data for print:', error);
    showToast('載入列印資料失敗：' + toErrorMessage(error), 'error');
  }

  let detailsHtml = '';
  if (lineItems.length > 0) {
    let lastOrderNo = null;
    let totalSubtotal = 0;

    const rowsHtml = lineItems.map(line => {
      const showOrderInfo = line.order_no !== lastOrderNo;
      lastOrderNo = line.order_no;
      totalSubtotal += Number(line.subtotal);

      return `
        <tr>
          <td>${showOrderInfo ? formatDate(line.order_date) : ''}</td>
          <td>${showOrderInfo ? escapeHtml(line.order_no) : ''}</td>
          <td>${escapeHtml(line.product_name)}</td>
          <td>${escapeHtml(line.spec || '')}</td>
          <td>${escapeHtml(line.qty)}</td>
          <td>${escapeHtml(line.unit || '')}</td>
          <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(line.unit_price)}</td>
          <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(line.subtotal)}</td>
        </tr>
      `;
    }).join('');

    detailsHtml = `
      <table style="margin-bottom: 2rem;">
        <thead>
          <tr>
            <th>日期</th><th>單號</th><th>品名</th><th>規格</th>
            <th>數量</th><th>單位</th><th>單價</th><th>金額</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
          <tr>
            <td colspan="7" style="text-align: right; font-weight: bold;">明細合計</td>
            <td style="font-weight: bold; font-family: 'Roboto', sans-serif;">${formatCurrency(totalSubtotal)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  printArea.innerHTML = `
    <div class="print-doc-header">
      <h1>藝境裝潢材料行</h1>
      <h2>收款單</h2>
    </div>
    <div class="print-info-box">
      <div>
        <p><strong>客戶編號：</strong>${escapeHtml(partner?.partner_no || '')}</p>
        <p><strong>客戶名稱：</strong>${escapeHtml(payment.partner_name || partner?.name || '')}</p>
        <p><strong>統一編號：</strong>${escapeHtml(partner?.tax_id || '')}</p>
      </div>
      <div>
        <p><strong>收款單號：</strong>${escapeHtml(payment.payment_no)}</p>
        <p><strong>收款日期：</strong>${formatDate(payment.payment_date)}</p>
        <p><strong>聯絡電話：</strong>${escapeHtml(partner?.phone || '')}</p>
      </div>
    </div>
    ${detailsHtml}
    <table>
      <thead>
        <tr>
          <th>收款日期</th><th>收款方式</th><th>備註</th><th>收款金額</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${formatDate(payment.payment_date)}</td>
          <td>${methodMap[payment.method] || escapeHtml(payment.method)}</td>
          <td>${escapeHtml(payment.note || '')}</td>
          <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(payment.amount)}</td>
        </tr>
        ${balance !== null && balance !== undefined ? `
        <tr>
          <td colspan="3" style="text-align: right; font-weight: bold;">收款後應收餘額</td>
          <td style="font-weight: bold; font-family: 'Roboto', sans-serif;">${formatCurrency(balance)}</td>
        </tr>` : ''}
      </tbody>
    </table>
    <div class="print-footer">
      <div>經手人簽名：<span class="signature-line"></span></div>
    </div>
  `;

  window.print();
}

function updatePagination() {
  renderPagination({ page: currentPage, total: totalCount, pageSize: PAGE_SIZE });
}

function runSearch() {
  if (searchDateFrom.value && searchDateTo.value && searchDateFrom.value > searchDateTo.value) {
    showToast('開始日期不可晚於結束日期', 'error');
    return;
  }
  currentPage = 1;
  loadPayments();
}

function setupEventListeners() {
  btnPrevPage.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadPayments();
    }
  });

  btnNextPage.addEventListener('click', () => {
    if (currentPage < totalPages(totalCount)) {
      currentPage++;
      loadPayments();
    }
  });

  [searchDateFrom, searchDateTo, searchPartner, searchMethod].forEach(el => {
    el.addEventListener('change', runSearch);
  });

  searchKeyword.addEventListener('input', debounce(runSearch, 400));

  btnResetSearch.addEventListener('click', () => {
    searchDateFrom.value = '';
    searchDateTo.value = '';
    searchPartner.value = 'all';
    searchMethod.value = 'all';
    searchKeyword.value = '';
    orderFilterId = null;
    orderFilterNo = null;
    currentPage = 1;
    loadPayments();
  });

  document.getElementById('btn-add-payment').addEventListener('click', () => openPaymentModal());

  bindSubmitOnce('btn-save-payment', savePayment);

  paymentPartner.addEventListener('change', (e) => {
    const partnerId = e.target.value;
    const paymentId = document.getElementById('payment-id').value;
    renderPartnerBalanceHint(partnerId);
    loadAllocatableOrders(partnerId, paymentId || null);
  });

  paymentAmount.addEventListener('input', updateAllocatedTotal);

  btnAutoAllocate.addEventListener('click', autoAllocate);
}

onReady(init);
