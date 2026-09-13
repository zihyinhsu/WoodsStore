import { sb } from './supabase.js';
import { formatCurrency, formatDate, showToast, openModal, closeModal, toErrorMessage } from './ui.js';

const PAGE_SIZE = 20;
let currentPage = 1;
let totalCount = 0;
let currentPayments = [];
let partnersCache = [];

// DOM Elements
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const pageInfo = document.getElementById('page-info');
const paymentPartner = document.getElementById('payment-partner');
const paymentOrdersList = document.getElementById('payment-orders-list');
const allocatedTotal = document.getElementById('allocated-total');
const btnCopyAllocated = document.getElementById('btn-copy-allocated');

const methodMap = {
  'cash': '現金',
  'transfer': '匯款',
  'check': '支票'
};

async function loadUnallocatedOrders(partnerId, paymentId = null) {
  if (!partnerId) {
    paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">請先選擇客戶</div>';
    updateAllocatedTotal();
    return;
  }

  paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">載入中...</div>';
  
  try {
    let linkedOrders = [];
    if (paymentId) {
      const { data: links, error: linkErr } = await sb.from('payment_orders').select('order_id').eq('payment_id', paymentId);
      if (linkErr) throw linkErr;
      
      if (links && links.length > 0) {
        const linkedIds = links.map(l => l.order_id);
        const { data: linkedData, error: linkedErr } = await sb.from('order_search_view')
          .select('id, order_no, order_date, total_amount')
          .in('id', linkedIds)
          .order('order_date');
        if (linkedErr) throw linkedErr;
        linkedOrders = linkedData || [];
      }
    }

    const { data: unallocated, error: unallocErr } = await sb.from('unpaid_order_view')
      .select('*')
      .eq('partner_id', partnerId)
      .order('order_date');
    if (unallocErr) throw unallocErr;

    const unallocatedOrders = unallocated || [];

    if (linkedOrders.length === 0 && unallocatedOrders.length === 0) {
      paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">此客戶目前沒有未沖帳的出貨單</div>';
      updateAllocatedTotal();
      return;
    }

    let html = '';
    
    linkedOrders.forEach(o => {
      html += `
        <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; cursor: pointer; border-bottom: 1px solid var(--border); min-height: 40px;">
          <input type="checkbox" class="order-checkbox" value="${o.id}" data-total="${o.total_amount}" checked>
          <span style="flex: 1;">${formatDate(o.order_date)} - ${o.order_no}</span>
          <span style="font-family: 'Roboto', sans-serif; font-weight: bold;">${formatCurrency(o.total_amount)}</span>
        </label>
      `;
    });

    unallocatedOrders.forEach(o => {
      html += `
        <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; cursor: pointer; border-bottom: 1px solid var(--border); min-height: 40px;">
          <input type="checkbox" class="order-checkbox" value="${o.id}" data-total="${o.order_total}">
          <span style="flex: 1;">${formatDate(o.order_date)} - ${o.order_no}</span>
          <span style="font-family: 'Roboto', sans-serif; font-weight: bold;">${formatCurrency(o.order_total)}</span>
        </label>
      `;
    });

    paymentOrdersList.innerHTML = html;
    
    document.querySelectorAll('.order-checkbox').forEach(cb => {
      cb.addEventListener('change', updateAllocatedTotal);
    });
    
    updateAllocatedTotal();
  } catch (error) {
    console.error('Error loading orders:', error);
    paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0; color: var(--danger);">載入失敗</div>';
    showToast('載入出貨單失敗: ' + error.message, 'error');
  }
}

function updateAllocatedTotal() {
  let total = 0;
  document.querySelectorAll('.order-checkbox:checked').forEach(cb => {
    total += parseFloat(cb.getAttribute('data-total') || 0);
  });
  allocatedTotal.textContent = formatCurrency(total);
  allocatedTotal.setAttribute('data-value', total);
}

async function init() {
  await Promise.all([
    loadPartnersCache(),
    loadBalances(),
    loadPayments()
  ]);

  setupEventListeners();
}

async function loadPartnersCache() {
  const { data } = await sb.from('partners').select('*').eq('type', 'customer');
  partnersCache = data || [];
  
  const select = document.getElementById('payment-partner');
  select.innerHTML = '<option value="">請選擇...</option>' + 
    partnersCache.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

async function loadBalances() {
  try {
    const { data, error } = await sb.from('partner_balance_view').select('*');
    if (error) throw error;
    
    const tbody = document.querySelector('#balance-table tbody');
    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">無客戶資料</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.map(b => `
      <tr>
        <td>${b.partner_no || '-'}</td>
        <td>${b.name}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_sales)}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_paid)}</td>
        <td class="balance-amount ${b.balance > 0 ? 'positive' : ''}" style="font-family: 'Roboto', sans-serif;">
          ${formatCurrency(b.balance)}
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Error loading balances:', error);
    showToast('載入餘額失敗: ' + error.message, 'error');
  }
}

async function loadPayments() {
  try {
    const from = (currentPage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    
    const { data, count, error } = await sb
      .from('payments')
      .select('*, partners(name, partner_no)', { count: 'exact' })
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to);
      
    if (error) throw error;
    
    currentPayments = data;
    totalCount = count;
    
    renderPaymentsTable();
    updatePagination();
  } catch (error) {
    console.error('Error loading payments:', error);
    showToast('載入收款紀錄失敗: ' + error.message, 'error');
  }
}

function renderPaymentsTable() {
  const tbody = document.querySelector('#payments-table tbody');
  if (currentPayments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">無收款紀錄</td></tr>';
    return;
  }
  
  tbody.innerHTML = currentPayments.map(p => `
    <tr>
      <td>${formatDate(p.payment_date)}</td>
      <td>${p.payment_no}</td>
      <td>${p.partners?.name || '-'}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.amount)}</td>
      <td>${methodMap[p.method] || p.method}</td>
      <td>${p.note || '-'}</td>
      <td>
        <button class="btn btn-outline btn-edit-payment" data-id="${p.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">編輯</button>
        <button class="btn btn-outline btn-print" data-id="${p.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">列印</button>
        <button class="btn btn-outline btn-delete-payment" data-id="${p.id}" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; color: #b3261e;">刪除</button>
      </td>
    </tr>
  `).join('');
  
  document.querySelectorAll('.btn-print').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.getAttribute('data-id');
      const payment = currentPayments.find(p => p.id === id);
      if (payment) printPayment(payment);
    });
  });

  document.querySelectorAll('.btn-edit-payment').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.getAttribute('data-id');
      const payment = currentPayments.find(p => p.id === id);
      if (payment) openPaymentModal(payment);
    });
  });

  document.querySelectorAll('.btn-delete-payment').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-id');
      const payment = currentPayments.find(p => p.id === id);
      if (!payment) return;

      if (confirm(`確定要刪除收款單 ${payment.payment_no}（${formatCurrency(payment.amount)}）嗎？\n刪除後客戶應收餘額會增加。`)) {
        await deletePayment(id);
      }
    });
  });
}

function openPaymentModal(payment = null) {
  const form = document.getElementById('payment-form');
  form.reset();
  document.getElementById('payment-date').value = new Date().toISOString().split('T')[0];
  paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">請先選擇客戶</div>';
  updateAllocatedTotal();

  if (payment) {
    document.getElementById('payment-modal-title').textContent = '編輯收款';
    document.getElementById('payment-id').value = payment.id;
    document.getElementById('payment-partner').value = payment.partner_id;
    document.getElementById('payment-date').value = payment.payment_date;
    document.getElementById('payment-amount').value = payment.amount;
    document.getElementById('payment-method').value = payment.method;
    document.getElementById('payment-note').value = payment.note || '';
    loadUnallocatedOrders(payment.partner_id, payment.id);
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

async function printPayment(payment) {
  const printArea = document.getElementById('print-area');

  let partner = null;
  let balance = null;
  let linkedOrderIds = [];
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
    
    if (linksRes.data && linksRes.data.length > 0) {
      linkedOrderIds = linksRes.data.map(l => l.order_id);
      const { data: lines, error: linesErr } = await sb.from('statement_line_view')
        .select('*')
        .in('order_id', linkedOrderIds)
        .order('order_date');
      if (linesErr) throw linesErr;
      if (lines) {
        lineItems = lines;
      }
    }
  } catch (error) {
    console.error('Error loading data for print:', error);
    showToast('載入列印資料失敗: ' + error.message, 'error');
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
          <td>${showOrderInfo ? line.order_no : ''}</td>
          <td>${line.product_name}</td>
          <td>${line.spec || ''}</td>
          <td>${line.qty}</td>
          <td>${line.unit || ''}</td>
          <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(line.unit_price)}</td>
          <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(line.subtotal)}</td>
        </tr>
      `;
    }).join('');

    detailsHtml = `
      <table style="margin-bottom: 2rem;">
        <thead>
          <tr>
            <th>日期</th>
            <th>單號</th>
            <th>品名</th>
            <th>規格</th>
            <th>數量</th>
            <th>單位</th>
            <th>單價</th>
            <th>金額</th>
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
        <p><strong>客戶編號：</strong>${partner?.partner_no || ''}</p>
        <p><strong>客戶名稱：</strong>${payment.partners?.name || partner?.name || ''}</p>
        <p><strong>統一編號：</strong>${partner?.tax_id || ''}</p>
      </div>
      <div>
        <p><strong>收款單號：</strong>${payment.payment_no}</p>
        <p><strong>收款日期：</strong>${formatDate(payment.payment_date)}</p>
        <p><strong>聯絡電話：</strong>${partner?.phone || ''}</p>
      </div>
    </div>
    ${detailsHtml}
    <table>
      <thead>
        <tr>
          <th>收款日期</th>
          <th>收款方式</th>
          <th>備註</th>
          <th>收款金額</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${formatDate(payment.payment_date)}</td>
          <td>${methodMap[payment.method] || payment.method}</td>
          <td>${payment.note || ''}</td>
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
      <div>
        經手人簽名：<span class="signature-line"></span>
      </div>
    </div>
  `;

  window.print();
}

function updatePagination() {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  pageInfo.textContent = `第 ${currentPage} / ${totalPages} 頁 (共 ${totalCount} 筆)`;
  
  btnPrevPage.disabled = currentPage <= 1;
  btnNextPage.disabled = currentPage >= totalPages;
}

async function savePayment() {
  const form = document.getElementById('payment-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  
  const id = document.getElementById('payment-id').value;
  const paymentData = {
    partner_id: document.getElementById('payment-partner').value,
    payment_date: document.getElementById('payment-date').value,
    amount: parseFloat(document.getElementById('payment-amount').value),
    method: document.getElementById('payment-method').value,
    note: document.getElementById('payment-note').value || null
  };

  const checkedOrders = Array.from(document.querySelectorAll('.order-checkbox:checked')).map(cb => cb.value);

  try {
    let error;
    let savedPaymentId = id;

    if (id) {
      const res = await sb.from('payments').update(paymentData).eq('id', id);
      error = res.error;
    } else {
      const now = new Date();
      const stamp = now.getFullYear()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
      const randomHex = Math.floor(Math.random() * 65536).toString(16).padStart(4, '0').toUpperCase();
      paymentData.payment_no = `PAY-${stamp}-${randomHex}`;

      const res = await sb.from('payments').insert([paymentData]).select('id').single();
      error = res.error;
      if (res.data) {
        savedPaymentId = res.data.id;
      }
    }

    if (error) throw error;

    if (id) {
      const { error: delErr } = await sb.from('payment_orders').delete().eq('payment_id', id);
      if (delErr) {
        console.error('Error deleting payment_orders:', delErr);
        showToast('更新沖帳紀錄失敗，但收款已儲存', 'warning');
      }
    }

    if (checkedOrders.length > 0 && savedPaymentId) {
      const links = checkedOrders.map(orderId => ({
        payment_id: savedPaymentId,
        order_id: orderId
      }));
      const { error: insErr } = await sb.from('payment_orders').insert(links);
      if (insErr) {
        console.error('Error inserting payment_orders:', insErr);
        showToast('儲存沖帳紀錄失敗，但收款已儲存', 'warning');
      }
    }

    showToast(id ? '收款紀錄已更新' : '收款紀錄已儲存', 'success');
    closeModal('payment-modal');
    
    // Reload data
    currentPage = 1;
    await Promise.all([
      loadBalances(),
      loadPayments()
    ]);
  } catch (error) {
    console.error('Error saving payment:', error);
    showToast('儲存失敗：' + toErrorMessage(error), 'error');
  }
}

function setupEventListeners() {
  btnPrevPage.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadPayments();
    }
  });

  btnNextPage.addEventListener('click', () => {
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage++;
      loadPayments();
    }
  });
  
  document.getElementById('btn-add-payment').addEventListener('click', () => {
    openPaymentModal();
  });
  
  document.getElementById('btn-save-payment').addEventListener('click', savePayment);

  paymentPartner.addEventListener('change', (e) => {
    const partnerId = e.target.value;
    const paymentId = document.getElementById('payment-id').value;
    loadUnallocatedOrders(partnerId, paymentId || null);
  });

  btnCopyAllocated.addEventListener('click', () => {
    const total = allocatedTotal.getAttribute('data-value');
    if (total && parseFloat(total) > 0) {
      document.getElementById('payment-amount').value = total;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);