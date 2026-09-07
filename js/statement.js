import { sb } from './supabase.js';
import { formatCurrency, formatDate, showToast } from './ui.js';

let partnersCache = [];

// DOM Elements
const partnerSelect = document.getElementById('statement-partner');
const dateFrom = document.getElementById('statement-date-from');
const dateTo = document.getElementById('statement-date-to');
const btnGenerate = document.getElementById('btn-generate');
const btnPrint = document.getElementById('btn-print');
const statementArea = document.getElementById('statement-area');

async function init() {
  // Default to current month
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  
  dateFrom.value = firstDay.toISOString().split('T')[0];
  dateTo.value = lastDay.toISOString().split('T')[0];

  await loadPartnersCache();
  setupEventListeners();
}

async function loadPartnersCache() {
  const { data } = await sb.from('partners').select('*').eq('type', 'customer');
  partnersCache = data || [];
  
  partnerSelect.innerHTML = '<option value="">請選擇...</option>' + 
    partnersCache.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

async function generateStatement() {
  const partnerId = partnerSelect.value;
  const from = dateFrom.value;
  const to = dateTo.value;
  
  if (!partnerId) {
    showToast('請選擇客戶', 'error');
    return;
  }
  if (!from || !to) {
    showToast('請選擇日期區間', 'error');
    return;
  }

  const partner = partnersCache.find(p => p.id === partnerId);
  
  try {
    // 1. Get statement lines in range
    const { data: lines, error: err1 } = await sb
      .from('statement_line_view')
      .select('*')
      .eq('partner_id', partnerId)
      .gte('order_date', from)
      .lte('order_date', to)
      .order('order_date', { ascending: true })
      .order('order_no', { ascending: true });
      
    if (err1) throw err1;

    // 2. Get payments in range
    const { data: currentPayments, error: err2 } = await sb
      .from('payments')
      .select('amount')
      .eq('partner_id', partnerId)
      .gte('payment_date', from)
      .lte('payment_date', to);
      
    if (err2) throw err2;

    // 3. Get previous sales (before 'from')
    const { data: prevSales, error: err3 } = await sb
      .from('statement_line_view')
      .select('subtotal')
      .eq('partner_id', partnerId)
      .lt('order_date', from);
      
    if (err3) throw err3;

    // 4. Get previous payments (before 'from')
    const { data: prevPayments, error: err4 } = await sb
      .from('payments')
      .select('amount')
      .eq('partner_id', partnerId)
      .lt('payment_date', from);
      
    if (err4) throw err4;

    // Calculate totals
    const currentSalesTotal = lines.reduce((sum, line) => sum + Number(line.subtotal), 0);
    const currentPaidTotal = currentPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    
    const prevSalesTotal = prevSales.reduce((sum, line) => sum + Number(line.subtotal), 0);
    const prevPaidTotal = prevPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const prevBalance = prevSalesTotal - prevPaidTotal;
    
    const totalBalance = prevBalance + currentSalesTotal - currentPaidTotal;

    // Render Header
    document.getElementById('st-partner-no').textContent = partner.partner_no || '';
    document.getElementById('st-partner-name').textContent = partner.name || '';
    document.getElementById('st-partner-tax').textContent = partner.tax_id || '';
    document.getElementById('st-partner-phone').textContent = partner.phone || '';
    document.getElementById('st-partner-address').textContent = partner.address || '';
    document.getElementById('st-date-range').textContent = `${formatDate(from)} ~ ${formatDate(to)}`;

    // Render Lines
    const tbody = document.getElementById('st-lines');
    if (lines.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">此期間無出貨紀錄</td></tr>';
    } else {
      let lastOrderNo = null;
      tbody.innerHTML = lines.map(line => {
        const showOrderInfo = line.order_no !== lastOrderNo;
        lastOrderNo = line.order_no;
        
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
    }

    // Render Footer
    document.getElementById('st-prev-balance').textContent = formatCurrency(prevBalance);
    document.getElementById('st-current-sales').textContent = formatCurrency(currentSalesTotal);
    document.getElementById('st-current-paid').textContent = formatCurrency(currentPaidTotal);
    document.getElementById('st-total-balance').textContent = formatCurrency(totalBalance);

    statementArea.style.display = 'block';
    btnPrint.disabled = false;
    
  } catch (error) {
    console.error('Error generating statement:', error);
    showToast('產生對帳單失敗: ' + error.message, 'error');
  }
}

function setupEventListeners() {
  btnGenerate.addEventListener('click', generateStatement);
  btnPrint.addEventListener('click', () => {
    window.print();
  });
}

document.addEventListener('DOMContentLoaded', init);