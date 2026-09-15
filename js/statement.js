import { sb } from './supabase.js';
import { showToast } from './ui.js';
import { requireAuth } from './auth.js';
import { formatCurrency, formatDate, escapeHtml, sum, groupBy, dateRange } from './utils.js';

// DOM Elements
const dateFrom = document.getElementById('statement-date-from');
const dateTo = document.getElementById('statement-date-to');
const btnSearch = document.getElementById('btn-search');
const btnPrintSelected = document.getElementById('btn-print-selected');
const btnPrintAll = document.getElementById('btn-print-all');
const tabsEl = document.getElementById('statement-tabs');
const statementArea = document.getElementById('statement-area');
const hintEl = document.getElementById('statement-hint');
const toolbarEl = document.getElementById('statement-toolbar');
const selectAllEl = document.getElementById('select-all');
const selectCountEl = document.getElementById('select-count');

let activePartnerId = null;
let selectedIds = new Set();
let partnerCount = 0;

function init() {
  const range = dateRange('currentMonth');
  dateFrom.value = range.from;
  dateTo.value = range.to;

  setupEventListeners();
}

async function searchStatements() {
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
    // 1. 期間內所有客戶的出貨明細
    const { data: lines, error: errLines } = await sb
      .from('statement_line_view')
      .select('*')
      .gte('order_date', from)
      .lte('order_date', to)
      .order('order_date', { ascending: true })
      .order('order_no', { ascending: true });
    if (errLines) throw errLines;

    // 2. 期間內所有客戶的收款
    const { data: payments, error: errPayments } = await sb
      .from('payments')
      .select('partner_id, amount')
      .gte('payment_date', from)
      .lte('payment_date', to);
    if (errPayments) throw errPayments;

    const linesByPartner = groupBy(lines || [], 'partner_id');
    const paymentsByPartner = groupBy(payments || [], 'partner_id');

    // 期間內有出貨或有收款的客戶，才算「有對帳單」
    const partnerIds = [...new Set([...linesByPartner.keys(), ...paymentsByPartner.keys()])];

    if (partnerIds.length === 0) {
      renderEmpty(from, to);
      return;
    }

    // 3. 客戶基本資料
    const { data: partners, error: errPartners } = await sb
      .from('partners')
      .select('*')
      .in('id', partnerIds);
    if (errPartners) throw errPartners;

    // 4. 期前出貨與期前收款（計算期前累計應收）
    const [prevSalesRes, prevPaymentsRes] = await Promise.all([
      sb.from('statement_line_view')
        .select('partner_id, subtotal')
        .in('partner_id', partnerIds)
        .lt('order_date', from),
      sb.from('payments')
        .select('partner_id, amount')
        .in('partner_id', partnerIds)
        .lt('payment_date', from)
    ]);
    if (prevSalesRes.error) throw prevSalesRes.error;
    if (prevPaymentsRes.error) throw prevPaymentsRes.error;

    const prevSalesByPartner = groupBy(prevSalesRes.data || [], 'partner_id');
    const prevPaymentsByPartner = groupBy(prevPaymentsRes.data || [], 'partner_id');

    const customers = partners
      .map(partner => {
        const partnerLines = linesByPartner.get(partner.id) || [];
        const currentSales = sum(partnerLines, 'subtotal');
        const currentPaid = sum(paymentsByPartner.get(partner.id) || [], 'amount');
        const prevSales = sum(prevSalesByPartner.get(partner.id) || [], 'subtotal');
        const prevPaid = sum(prevPaymentsByPartner.get(partner.id) || [], 'amount');
        const prevBalance = prevSales - prevPaid;

        return {
          partner,
          lines: partnerLines,
          currentSales,
          currentPaid,
          prevPaid,
          prevBalance,
          totalBalance: prevBalance + currentSales - currentPaid
        };
      })
      .sort((a, b) => (a.partner.name || '').localeCompare(b.partner.name || '', 'zh-Hant'));

    renderStatements(customers, from, to);
  } catch (error) {
    console.error('Error searching statements:', error);
    showToast('查詢對帳單失敗: ' + error.message, 'error');
  } finally {
    btnSearch.disabled = false;
  }
}

function renderEmpty(from, to) {
  activePartnerId = null;
  selectedIds = new Set();
  partnerCount = 0;
  tabsEl.innerHTML = '';
  statementArea.innerHTML = '';
  toolbarEl.hidden = true;
  hintEl.hidden = false;
  hintEl.textContent = `${formatDate(from)} ~ ${formatDate(to)} 期間內沒有任何客戶的對帳單。`;
  btnPrintSelected.disabled = true;
  btnPrintAll.disabled = true;
  syncSelectionUI();
}

function renderStatements(customers, from, to) {
  hintEl.hidden = true;
  toolbarEl.hidden = false;

  partnerCount = customers.length;
  selectedIds = new Set(customers.map(c => c.partner.id));

  tabsEl.innerHTML = customers.map((customer, index) => {
    const id = escapeHtml(customer.partner.id);
    return `
      <div class="statement-tab${index === 0 ? ' is-active' : ''}" data-partner-id="${id}">
        <label class="checkbox">
          <input type="checkbox"
                 class="tab-check"
                 data-partner-id="${id}"
                 checked
                 aria-label="選取 ${escapeHtml(customer.partner.name)} 以供列印">
          <span class="checkbox-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </span>
        </label>
        <button type="button"
                class="tab-label"
                role="tab"
                id="tab-${id}"
                aria-selected="${index === 0}"
                aria-controls="panel-${id}"
                data-partner-id="${id}">
          <span>${escapeHtml(customer.partner.name)}</span>
          <span class="tab-balance">${escapeHtml(formatCurrency(customer.totalBalance))}</span>
        </button>
      </div>
    `;
  }).join('');

  statementArea.innerHTML = customers.map((customer, index) =>
    renderStatementSection(customer, from, to, index === 0)
  ).join('');

  activePartnerId = customers[0].partner.id;
  btnPrintAll.disabled = false;
  syncSelectionUI();
}

function syncSelectionUI() {
  const count = selectedIds.size;

  btnPrintSelected.disabled = count === 0;
  btnPrintSelected.textContent = count > 0 ? `列印選取（${count}）` : '列印選取';
  selectCountEl.textContent = partnerCount > 0 ? `已選 ${count} / ${partnerCount} 家` : '';

  selectAllEl.checked = partnerCount > 0 && count === partnerCount;
  selectAllEl.indeterminate = count > 0 && count < partnerCount;
}

function toggleSelection(partnerId, isSelected) {
  if (isSelected) selectedIds.add(partnerId);
  else selectedIds.delete(partnerId);
  syncSelectionUI();
}

function toggleSelectAll(isSelected) {
  const checkboxes = tabsEl.querySelectorAll('.tab-check');
  selectedIds = isSelected
    ? new Set([...checkboxes].map(cb => cb.dataset.partnerId))
    : new Set();
  checkboxes.forEach(cb => { cb.checked = isSelected; });
  syncSelectionUI();
}

function renderStatementSection(customer, from, to, isActive) {
  const { partner, lines, prevBalance, prevPaid, currentSales, currentPaid, totalBalance } = customer;

  let lastOrderNo = null;
  const rows = lines.length === 0
    ? '<tr><td colspan="8" class="text-center">此期間無出貨紀錄</td></tr>'
    : lines.map(line => {
        const showOrderInfo = line.order_no !== lastOrderNo;
        lastOrderNo = line.order_no;
        return `
          <tr>
            <td>${showOrderInfo ? escapeHtml(formatDate(line.order_date)) : ''}</td>
            <td>${showOrderInfo ? escapeHtml(line.order_no) : ''}</td>
            <td>${escapeHtml(line.product_name)}</td>
            <td>${escapeHtml(line.spec || '')}</td>
            <td>${escapeHtml(line.qty)}</td>
            <td>${escapeHtml(line.unit || '')}</td>
            <td style="font-family: 'Roboto', sans-serif;">${escapeHtml(formatCurrency(line.unit_price))}</td>
            <td style="font-family: 'Roboto', sans-serif;">${escapeHtml(formatCurrency(line.subtotal))}</td>
          </tr>
        `;
      }).join('');

  return `
    <section class="statement-section${isActive ? ' is-active' : ''}"
             id="panel-${escapeHtml(partner.id)}"
             role="tabpanel"
             aria-labelledby="tab-${escapeHtml(partner.id)}"
             data-partner-id="${escapeHtml(partner.id)}"
             ${isActive ? '' : 'hidden'}>
      <div class="statement-preview">
        <div class="statement-header">
          <h1>藝境裝潢材料行</h1>
          <h2>應收帳款明細表</h2>
        </div>

        <div class="customer-info">
          <div>
            <p><strong>客戶編號：</strong>${escapeHtml(partner.partner_no || '')}</p>
            <p><strong>公司名稱：</strong>${escapeHtml(partner.name || '')}</p>
            <p><strong>統一編號：</strong>${escapeHtml(partner.tax_id || '')}</p>
          </div>
          <div>
            <p><strong>聯絡電話：</strong>${escapeHtml(partner.phone || '')}</p>
            <p><strong>聯絡地址：</strong>${escapeHtml(partner.address || '')}</p>
            <p><strong>對帳期間：</strong>${escapeHtml(formatDate(from))} ~ ${escapeHtml(formatDate(to))}</p>
          </div>
        </div>

        <table class="statement-table">
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
          <tbody>${rows}</tbody>
        </table>

        <div class="statement-footer">
          <table class="totals-table">
            <tbody>
              <tr><th>前期累計應收未收</th><td>${escapeHtml(formatCurrency(prevBalance))}</td></tr>
              <tr class="ref-row">
                <th>前期累計已收<small>（已含於上列計算）</small></th>
                <td>${escapeHtml(formatCurrency(prevPaid))}</td>
              </tr>
              <tr><th>本期應收</th><td>${escapeHtml(formatCurrency(currentSales))}</td></tr>
              <tr><th>本期已收</th><td>${escapeHtml(formatCurrency(currentPaid))}</td></tr>
              <tr>
                <th class="grand-total">合計應收</th>
                <td class="grand-total">${escapeHtml(formatCurrency(totalBalance))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function selectPartner(partnerId) {
  activePartnerId = partnerId;

  tabsEl.querySelectorAll('.statement-tab').forEach(tab => {
    tab.classList.toggle('is-active', tab.dataset.partnerId === partnerId);
  });
  tabsEl.querySelectorAll('.tab-label').forEach(label => {
    label.setAttribute('aria-selected', String(label.dataset.partnerId === partnerId));
  });

  statementArea.querySelectorAll('.statement-section').forEach(section => {
    const isActive = section.dataset.partnerId === partnerId;
    section.classList.toggle('is-active', isActive);
    section.hidden = !isActive;
  });
}

function applySelectionToSections() {
  statementArea.querySelectorAll('.statement-section').forEach(section => {
    section.classList.toggle('is-selected', selectedIds.has(section.dataset.partnerId));
  });
}

function printWithMode(mode) {
  document.body.classList.add(mode);

  // 不依賴 afterprint：部分瀏覽器在取消列印時不會觸發，
  // class 殘留會讓畫面卡在列印模式。
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    document.body.classList.remove(mode);
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  try {
    window.print();
  } finally {
    setTimeout(cleanup, 0);
  }
}

function setupEventListeners() {
  btnSearch.addEventListener('click', searchStatements);

  tabsEl.addEventListener('click', event => {
    const label = event.target.closest('.tab-label');
    if (label) selectPartner(label.dataset.partnerId);
  });

  tabsEl.addEventListener('change', event => {
    const check = event.target.closest('.tab-check');
    if (check) toggleSelection(check.dataset.partnerId, check.checked);
  });

  // 用 click 而非 change：半選（indeterminate）狀態下要能一次全選，
  // 只讀 checked 會讓「半選時點一下」的結果不符直覺。
  selectAllEl.addEventListener('click', () => toggleSelectAll(selectedIds.size < partnerCount));

  btnPrintSelected.addEventListener('click', () => {
    if (selectedIds.size === 0) return;
    applySelectionToSections();
    printWithMode('print-selected');
  });

  btnPrintAll.addEventListener('click', () => printWithMode('print-all'));
}

requireAuth(init);
