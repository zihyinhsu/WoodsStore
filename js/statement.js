import { showToast } from './ui.js';
import { requireAuth } from './auth.js';
import { fetchStatementSummary, fetchStatementLines } from './statement-data.js';
import { formatCurrency, formatDate, escapeHtml, dateRange, round2 } from './utils.js';

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

// 明細改按需載入：彙總（含期間）先存起來，切到某客戶或要列印時才依這些查明細。
let currentCustomers = [];
let currentFrom = '';
let currentTo = '';
// 已載入明細的客戶，避免重複切換時重撈。每次查詢清空。
const loadedPartners = new Set();

const LINES_LOADING = '<tr><td colspan="8" class="text-center">載入中…</td></tr>';

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
    // 彙總（期前餘額／本期應收／本期已收／合計）由後端一次算好，前端不再拉明細。
    // 明細改在切到該客戶時才載入（見 loadLines），避免區間拉大時全部客戶明細一次進瀏覽器。
    const customers = await fetchStatementSummary(from, to);

    if (customers.length === 0) {
      currentCustomers = [];
      renderEmpty(from, to);
      return;
    }

    // 中文姓名排序交給前端 localeCompare：Postgres 預設 collation 未必是台灣慣用序。
    customers.sort((a, b) =>
      (a.partner.name || '').localeCompare(b.partner.name || '', 'zh-Hant'));

    currentCustomers = customers;
    currentFrom = from;
    currentTo = to;
    loadedPartners.clear();

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
    // 用 round2 收斂浮點尾數再判斷正負，避免 0.0000001 這種殘值被歸成「欠款」
    const bal = round2(customer.totalBalance);
    const balClass = bal > 0 ? 'tab-balance--due' : bal < 0 ? 'tab-balance--credit' : 'tab-balance--zero';
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
          <span class="tab-balance ${balClass}">${escapeHtml(formatCurrency(customer.totalBalance))}</span>
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

  // 第一位客戶預設就在畫面上，立刻載入其明細；其餘客戶切到時才載入。
  loadLines(activePartnerId);
}

// 載入單一客戶的明細並填入其 section。已載入過的直接略過，避免重複切換時重撈。
async function loadLines(partnerId) {
  if (loadedPartners.has(partnerId)) return;

  const section = statementArea.querySelector(`.statement-section[data-partner-id="${partnerId}"]`);
  const tbody = section?.querySelector('.statement-table tbody');
  if (!tbody) return;

  try {
    const lines = await fetchStatementLines(partnerId, currentFrom, currentTo);
    tbody.innerHTML = renderLineRows(lines);
    loadedPartners.add(partnerId);
  } catch (error) {
    console.error('Error loading statement lines:', error);
    // 不加進 loadedPartners：保留下次切換或列印時重試的機會。
    tbody.innerHTML = '<tr><td colspan="8" class="text-center">明細載入失敗，請重新切換此客戶</td></tr>';
    showToast('載入明細失敗: ' + error.message, 'error');
  }
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
  const { partner, prevBalance, prevPaid, currentSales, currentPaid, totalBalance } = customer;

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

        <div class="statement-table-scroll">
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
            <tbody>${LINES_LOADING}</tbody>
          </table>
        </div>

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

// 明細列渲染。抽成獨立函式，讓「初次建骨架」與「按需載入後填入」共用同一段。
function renderLineRows(lines) {
  if (lines.length === 0) {
    return '<tr><td colspan="8" class="text-center">此期間無出貨紀錄</td></tr>';
  }

  let lastOrderNo = null;
  return lines.map(line => {
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

  // 不 await：切換要即時，明細載入完成後會自行填入該 section。
  loadLines(partnerId);
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

// 列印要輸出完整明細，但明細是按需載入的——先把目標客戶中「從沒點開過」的補撈進 DOM 再送印。
async function preparePrintAndPrint(mode, partnerIds, button) {
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = '準備中...';
  try {
    await Promise.all(partnerIds.map(id => loadLines(id)));
    if (mode === 'print-selected') applySelectionToSections();
    printWithMode(mode);
  } catch (error) {
    console.error('Error preparing print:', error);
    showToast('準備列印失敗: ' + error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = previousText;
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
    preparePrintAndPrint('print-selected', [...selectedIds], btnPrintSelected);
  });

  btnPrintAll.addEventListener('click', () =>
    preparePrintAndPrint('print-all', currentCustomers.map(c => c.partner.id), btnPrintAll));
}

requireAuth(init);
