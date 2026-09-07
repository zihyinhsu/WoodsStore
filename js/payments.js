import { sb } from './supabase.js';
import { formatCurrency, formatDate, showToast, openModal, closeModal } from './ui.js';

const PAGE_SIZE = 20;
let currentPage = 1;
let totalCount = 0;
let currentPayments = [];
let partnersCache = [];

// DOM Elements
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const pageInfo = document.getElementById('page-info');

const methodMap = {
  'cash': '現金',
  'transfer': '匯款',
  'check': '支票'
};

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

  if (payment) {
    document.getElementById('payment-modal-title').textContent = '編輯收款';
    document.getElementById('payment-id').value = payment.id;
    document.getElementById('payment-partner').value = payment.partner_id;
    document.getElementById('payment-date').value = payment.payment_date;
    document.getElementById('payment-amount').value = payment.amount;
    document.getElementById('payment-method').value = payment.method;
    document.getElementById('payment-note').value = payment.note || '';
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
    showToast('刪除失敗: ' + error.message, 'error');
  }
}

function printPayment(payment) {
  const printArea = document.getElementById('print-area');
  
  printArea.innerHTML = `
    <h1>藝境裝潢材料行</h1>
    <h2>收款單</h2>
    <div class="print-header-info">
      <div>
        <p><strong>單號：</strong>${payment.payment_no}</p>
        <p><strong>日期：</strong>${formatDate(payment.payment_date)}</p>
      </div>
      <div>
        <p><strong>客戶名稱：</strong>${payment.partners?.name || ''}</p>
      </div>
    </div>
    <table>
      <tbody>
        <tr>
          <th style="width: 150px;">收款金額</th>
          <td>${formatCurrency(payment.amount)}</td>
        </tr>
        <tr>
          <th>收款方式</th>
          <td>${methodMap[payment.method] || payment.method}</td>
        </tr>
        <tr>
          <th>備註</th>
          <td>${payment.note || ''}</td>
        </tr>
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

  try {
    let error;
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

      const res = await sb.from('payments').insert([paymentData]);
      error = res.error;
    }

    if (error) throw error;

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
    showToast('儲存失敗: ' + error.message, 'error');
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
}

document.addEventListener('DOMContentLoaded', init);