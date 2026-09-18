import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce, renderPagination, setupResponsiveTable } from './ui.js';
import { requireAuth } from './auth.js';
import { PAGE_SIZE, formatCurrency, formatDate, toDateInputValue, dateRange, debounce, round2, totalPages, escapeHtml, orderSearchLink, itemSummary } from './utils.js';

let currentPage = 1;
let totalCount = 0;
let currentPayments = [];
let partnersCache = [];
let balancePage = 1;
let balanceTotal = 0;
let orderFilterId = null;
let orderFilterNo = null;
let orderFilterPartnerId = null;
let autoExpanded = false;
// 非 null 代表正在編輯一筆舊版沖帳留下的收款，整個出貨單區塊唯讀（見 setLegacyLock）。
let legacyPayment = null;

const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const paymentPartner = document.getElementById('payment-partner');
const paymentOrdersList = document.getElementById('payment-orders-list');
const paymentAmount = document.getElementById('payment-amount');
const paymentAmountDisplay = document.getElementById('payment-amount-display');
const paymentLegacyHint = document.getElementById('payment-legacy-hint');
const partnerBalanceHint = document.getElementById('partner-balance-hint');
const orderFilterNotice = document.getElementById('order-filter-notice');

const balanceAsOfHint = document.getElementById('balance-asof-hint');
const toggleSettled = document.getElementById('toggle-settled');
const balanceKeyword = document.getElementById('balance-keyword');
const btnBalancePrev = document.getElementById('btn-balance-prev');
const btnBalanceNext = document.getElementById('btn-balance-next');

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
  setupResponsiveTable('#payments-table');
  setupResponsiveTable('#balance-table');

  const urlParams = new URLSearchParams(window.location.search);
  orderFilterId = urlParams.get('order_id');
  if (orderFilterId) await loadOrderFilterNo();

  // 指定單據時不套預設區間：該單的收款可能發生在 30 天前，
  // 預設區間會把它濾掉，使用者從單據頁點過來就只看到空表。
  const defaultRange = orderFilterId ? { from: '', to: '' } : dateRange('last30Days');
  searchDateFrom.value = urlParams.get('from') || defaultRange.from;
  searchDateTo.value = urlParams.get('to') || defaultRange.to;
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

// 餘額的截止日取搜尋列的「結束日期」，沒填就是今天。
// 刻意不吃開始日期：應收餘額是累計到某日的快照，不是期間發生額。
// 若只算區間內的出貨減收款，長期積欠但近期沒下單的客戶會顯示 0，
// 而他正是最該被追的人。
function balanceAsOf() {
  return searchDateTo.value || toDateInputValue(new Date());
}

function renderBalanceHint(asOf, partnerId) {
  const scopes = [];
  if (orderFilterId && orderFilterPartnerId) scopes.push('僅顯示該單據客戶');
  else if (partnerId) scopes.push('已依上方客戶條件篩選');
  if (balanceKeyword.value.trim()) scopes.push('已套用關鍵字');
  const scope = scopes.length ? `${scopes.join('、')}，` : '';
  balanceAsOfHint.textContent = `${scope}統計截至 ${formatDate(asOf)} 的累計金額，不受開始日期影響。`;
}

// 從單據頁帶 order_id 進來時，餘額表鎖定該單的客戶，讓使用者同時看到
// 「這張單的收款」與「這位客戶的總帳」。不改寫 searchPartner 的值：
// 那會連帶篩掉收款紀錄，而同一張單可能被不同客戶的收款沖過（例如代付），
// 篩掉反而讓使用者看不到完整的沖帳來源。
function balancePartnerId() {
  if (orderFilterId && orderFilterPartnerId) return orderFilterPartnerId;
  return searchPartner.value === 'all' ? null : searchPartner.value;
}

async function loadBalances() {
  const asOf = balanceAsOf();
  const partnerId = balancePartnerId();
  renderBalanceHint(asOf, partnerId);

  try {
    const from = (balancePage - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    // 指定客戶時一律顯示該客戶，即使已結清：使用者明確選了對象，
    // 讓他看到空白表格等於死路一條，因此 p_partner_id 壓過 include_settled。
    const { data, count, error } = await sb
      .rpc('get_partner_balances', {
        p_as_of: asOf,
        p_partner_id: partnerId,
        p_include_settled: toggleSettled.checked,
        p_keyword: balanceKeyword.value.trim() || null
      }, { count: 'exact' })
      // 排序在這裡再指定一次，不是多餘的：SQL function 被 inline 後外層會多包
      // 一層 SELECT，函式內的 ORDER BY 不保證留存，翻頁會出現重複或漏列。
      .order('partner_no', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (error) throw error;

    balanceTotal = count || 0;
    renderBalancesTable(data || []);
    updateBalancePagination();
  } catch (error) {
    console.error('Error loading balances:', error);
    showToast('載入餘額失敗：' + toErrorMessage(error), 'error');
  }
}

function renderBalancesTable(rows) {
  const tbody = document.querySelector('#balance-table tbody');

  if (rows.length === 0) {
    const keyword = balanceKeyword.value.trim();
    const message = keyword
      ? `找不到符合「${escapeHtml(keyword)}」的客戶。`
      : toggleSettled.checked
        ? '無客戶資料'
        : '所有客戶均已結清，可勾選「顯示已結清客戶」檢視全部。';
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${message}</td></tr>`;
    return;
  }

  // 不另列「未分配預收」：收款金額即所選單據的加總，新制不會再產生預收，
  // 舊資料殘留的部分也已算進已收款與應收餘額裡（溢付會讓餘額成為負數）。
  tbody.innerHTML = rows.map(b => {
    const balance = Number(b.balance);
    return `
      <tr>
        <td>${escapeHtml(b.partner_no || '-')}</td>
        <td>${escapeHtml(b.name)}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_sales)}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_paid)}</td>
        <td class="balance-amount ${balance > 0 ? 'positive' : balance < 0 ? 'negative' : ''}" style="font-family: 'Roboto', sans-serif;">
          ${formatCurrency(b.balance)}
        </td>
      </tr>
    `;
  }).join('');
}

function updateBalancePagination() {
  renderPagination({
    page: balancePage,
    total: balanceTotal,
    pageSize: PAGE_SIZE,
    unit: '位客戶',
    pageInfoId: 'balance-page-info',
    prevId: 'btn-balance-prev',
    nextId: 'btn-balance-next'
  });
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
      .select('order_no, partner_id')
      .eq('id', orderFilterId)
      .single();
    if (error) throw error;
    orderFilterNo = data?.order_no || null;
    orderFilterPartnerId = data?.partner_id || null;
  } catch (error) {
    console.error('Error loading filtered order:', error);
    orderFilterNo = null;
    orderFilterPartnerId = null;
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
    orderFilterPartnerId = null;
    autoExpanded = false;
    currentPage = 1;
    balancePage = 1;
    loadPayments();
    loadBalances();
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
    autoExpandFilteredOrder();
  } catch (error) {
    console.error('Error loading payments:', error);
    showToast('載入收款紀錄失敗：' + toErrorMessage(error), 'error');
  }
}

// 商品摘要為主、單號為輔的雙行儲存格（與單據管理同一種呈現）。
// 取不到代表品項時退成單行：沒有明細的單據會是這樣，資料庫尚未套用 patch-025 的
// 環境也會是這樣，那時每一列頂著一個 '-' 只是噪音，單號才是不能消失的資訊。
// subline 必須是已跳脫或已成形的 HTML（單號文字或 orderSearchLink 的連結）。
function itemSummaryCell(topItemName, itemCount, subline) {
  if (!topItemName) return subline;
  return `${itemSummary(topItemName, itemCount)}
    <span class="text-muted" style="font-size: 0.8rem; display: block;">${subline}</span>`;
}

// 一列只放得下一張單，所以顯示 view 挑出的代表單（分配金額最大那張），
// 沖多張時在單號後補「等 N 張」，要看齊全仍是展開明細。
// order_ids 是 order_count 的 fallback：patch-025 未套用時少了商品摘要無妨，
// 但張數與單號不能跟著消失。
function orderSummaryCell(payment) {
  const count = Number(payment.order_count) || (payment.order_ids?.length ?? 0);
  if (count === 0) return '-';

  const orderNo = payment.top_order_no || String(payment.order_nos || '').split(' ')[0];
  const label = `${escapeHtml(orderNo)}${count > 1 ? ` 等 ${count} 張` : ''}`;
  return itemSummaryCell(payment.top_item_name, payment.top_item_count, label);
}

function renderPaymentsTable() {
  const tbody = document.querySelector('#payments-table tbody');
  if (currentPayments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">找不到收款紀錄</td></tr>';
    return;
  }

  // 沒有獨立的「已沖帳」欄：新制的收款金額就是勾選單據的加總，兩者恆等。
  // 只有舊版手動沖帳留下的收款才可能有差額，那時才把未分配的部分標出來。
  tbody.innerHTML = currentPayments.map(p => {
    const unallocated = Number(p.unallocated_amount) || 0;
    return `
    <tr class="clickable-row" data-id="${escapeHtml(p.id)}">
      <td>${formatDate(p.payment_date)}</td>
      <td>${escapeHtml(p.payment_no)}</td>
      <td>${orderSummaryCell(p)}</td>
      <td>${escapeHtml(p.partner_name || '-')}</td>
      <td style="font-family: 'Roboto', sans-serif;">
        ${formatCurrency(p.amount)}
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

  document.querySelectorAll('#payments-table .clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      togglePaymentDetail(row.getAttribute('data-id'), row);
    });
  });

  document.querySelectorAll('.btn-print').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const payment = currentPayments.find(p => p.id === e.target.getAttribute('data-id'));
      if (payment) printPayment(payment);
    });
  });

  document.querySelectorAll('.btn-edit-payment').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const payment = currentPayments.find(p => p.id === e.target.getAttribute('data-id'));
      if (payment) openPaymentModal(payment);
    });
  });

  document.querySelectorAll('.btn-delete-payment').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const payment = currentPayments.find(p => p.id === e.target.getAttribute('data-id'));
      if (!payment) return;

      if (confirm(`確定要刪除收款單 ${payment.payment_no}（${formatCurrency(payment.amount)}）嗎？\n刪除後相關單據的付款狀態會一併回復。`)) {
        await deletePayment(payment.id);
      }
    });
  });
}

// 從單據頁點付款狀態帶 order_id 進來時，使用者要看的是「這張單被誰沖了、沖多少」，
// 因此直接展開沖帳明細，省去再點一次。
//
// 全部展開而非只展開第一筆：一張已付款的單常由多筆收款分次沖成，
// 每一筆都是答案的一部分，只展開一筆會讓使用者誤以為就只收過這麼多。
function autoExpandFilteredOrder() {
  if (!orderFilterId || autoExpanded) return;

  const rows = document.querySelectorAll('#payments-table .clickable-row');
  if (rows.length === 0) return;

  autoExpanded = true;
  rows.forEach(row => expandPaymentDetail(row.getAttribute('data-id'), row));
}

async function togglePaymentDetail(paymentId, rowElement) {
  const nextRow = rowElement.nextElementSibling;
  if (nextRow && nextRow.classList.contains('detail-row')) {
    nextRow.remove();
    rowElement.classList.remove('detail-open');
    rowElement.__detailToken = null;
    return;
  }

  // 明細是非同步載入，連點時第二次會在插入前就進來，
  // 因此用同步標記判定展開狀態，避免重複插入 detail-row。
  if (rowElement.classList.contains('detail-open')) {
    rowElement.classList.remove('detail-open');
    rowElement.__detailToken = null;
    return;
  }

  document.querySelectorAll('#payments-table .detail-row').forEach(el => el.remove());
  document.querySelectorAll('#payments-table .detail-open').forEach(el => el.classList.remove('detail-open'));

  await expandPaymentDetail(paymentId, rowElement);
}

async function expandPaymentDetail(paymentId, rowElement) {
  if (rowElement.classList.contains('detail-open')) return;
  rowElement.classList.add('detail-open');

  // 每次展開發一個新的 token，插入前比對是否仍是最新的一次。
  // token 記在該列自己身上而非共用變數：自動展開會同時開多列，
  // 共用變數會讓後發的請求作廢先發的，只剩最後一筆插得進去。
  const token = Symbol('detail');
  rowElement.__detailToken = token;

  try {
    const { data, error } = await sb
      .from('payment_allocation_view')
      .select('*')
      .eq('payment_id', paymentId)
      .order('order_date');

    if (error) throw error;
    if (rowElement.__detailToken !== token || !rowElement.classList.contains('detail-open')) return;

    const payment = currentPayments.find(p => p.id === paymentId);
    const unallocated = Number(payment?.unallocated_amount) || 0;
    const rows = data || [];

    const body = rows.length === 0
      ? '<tr><td colspan="4" class="empty-state">此筆收款未對應任何出貨單，全額列為預收。</td></tr>'
      : rows.map(a => `
          <tr class="${a.order_id === orderFilterId ? 'is-highlighted' : ''}">
            <td>${formatDate(a.order_date)}</td>
            <td>${itemSummaryCell(a.top_item_name, a.item_count, orderSearchLink(a.order_no, a.order_date))}</td>
            <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(a.order_total)}</td>
            <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(a.allocated_amount)}</td>
          </tr>`).join('');

    rowElement.insertAdjacentHTML('afterend', `
      <tr class="detail-row">
        <td colspan="8" style="padding: 1rem 2rem;">
          <h4 style="margin: 0 0 0.5rem;">本次收款的出貨單</h4>
          <table class="detail-table">
            <thead>
              <tr>
                <th>出貨日期</th>
                <th>出貨單</th>
                <th>單據金額</th>
                <th>本次收款</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
          ${unallocated > 0 ? `<p class="text-warning" style="margin: 0.5rem 0 0; font-size: 0.85rem;">未分配 ${formatCurrency(unallocated)}，列為預收。</p>` : ''}
        </td>
      </tr>`);
  } catch (error) {
    console.error('Error loading allocations:', error);
    if (rowElement.__detailToken !== token) return;
    rowElement.classList.remove('detail-open');
    showToast('載入收款明細失敗：' + toErrorMessage(error), 'error');
  }
}

// 這裡必須單筆查詢，不能沿用餘額表的資料：餘額表已改為分頁 + 可篩選，
// 選到不在當頁的客戶會查不到，提示會無聲消失——而那正是使用者判斷該收哪幾張單的依據。
async function renderPartnerBalanceHint(partnerId) {
  if (!partnerId) {
    partnerBalanceHint.style.display = 'none';
    partnerBalanceHint.innerHTML = '';
    return;
  }

  let balance = null;
  try {
    const { data, error } = await sb.rpc('get_partner_balances', {
      p_as_of: null,
      p_partner_id: partnerId,
      p_include_settled: true
    });
    if (error) throw error;
    balance = data?.[0] || null;
  } catch (error) {
    console.error('Error loading partner balance:', error);
  }

  if (!balance) {
    partnerBalanceHint.style.display = 'none';
    return;
  }

  partnerBalanceHint.style.display = '';
  partnerBalanceHint.innerHTML = `
    <span class="text-muted">目前應收餘額：</span>
    <strong class="${Number(balance.balance) > 0 ? 'text-danger' : 'text-success'}"
            style="font-family: 'Roboto', sans-serif;">${formatCurrency(balance.balance)}</strong>`;
}

// 新制一律「勾選即全額」：每一列的分配金額必等於該單當時的未收全額，
// 收款金額必等於分配總額。只要有一項不成立，就是舊版手動沖帳留下的資料——
// 用新規則重存會靜默改掉金額（部分沖帳被撐成全額、未分配預收被吃掉），
// 因此整區鎖為唯讀，要更正只能刪除重開，與「單據不可編輯」的處理方式一致。
function isLegacyAllocation(rows, payment) {
  if (!payment) return false;
  if (round2(Number(payment.unallocated_amount) || 0) > 0) return true;
  return rows.some(r => r.allocated > 0 && r.allocated < r.allocatable);
}

function setLegacyLock(payment) {
  legacyPayment = payment;
  // 客戶一併鎖住：換客戶會重載清單、讓區塊變回可編輯，等於繞過鎖定改掉金額。
  paymentPartner.disabled = Boolean(payment);

  if (!payment) {
    paymentLegacyHint.style.display = 'none';
    paymentLegacyHint.textContent = '';
    return;
  }

  const unallocated = round2(Number(payment.unallocated_amount) || 0);
  const reason = unallocated > 0 ? `含未分配預收 ${formatCurrency(unallocated)}` : '含部分沖帳';
  paymentLegacyHint.style.display = '';
  paymentLegacyHint.textContent =
    `此筆收款以舊版沖帳方式建立（${reason}），出貨單與金額不可調整。如需更正請刪除後重新開立。`;
}

// data-amount 是「這列被勾選時要送出的分配金額」：新制恆為該單未收全額，
// 舊制則是原本就存在的分配金額，唯讀且原樣送回。
function renderAllocationRow(r, legacy, items) {
  const amount = legacy ? r.allocated : r.allocatable;
  // 金額與單據總額不同時（別筆收款沖過一部分、或舊制部分沖帳），補上原始單據金額，
  // 否則使用者會以為系統把單據金額算錯了。
  const showTotal = round2(amount) !== round2(r.order_total);

  return `
    <div class="allocation-row" data-id="${escapeHtml(r.id)}" data-amount="${escapeHtml(amount)}"
         style="padding: 0.5rem; border-bottom: 1px solid var(--border-light);">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <label class="checkbox">
          <input type="checkbox" class="order-checkbox"
                 ${legacy || r.allocated > 0 ? 'checked' : ''} ${legacy ? 'disabled' : ''}>
          <span class="checkbox-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </span>
        </label>
        <span style="flex: 1;">
          ${formatDate(r.order_date)} - ${escapeHtml(r.order_no)}
          ${showTotal ? `<span class="text-muted" style="font-size: 0.8rem; display: block;">單據 ${formatCurrency(r.order_total)}</span>` : ''}
        </span>
        <strong style="font-family: 'Roboto', sans-serif;">${formatCurrency(amount)}</strong>
      </div>
      <div class="allocation-items">${renderOrderItems(items)}</div>
    </div>
  `;
}

// 明細必須維持純展示：updatePaymentAmount 與 collectAllocations 是全域掃
// .allocation-row 再往下找第一個 .order-checkbox，這個容器裡若出現同樣的結構，
// 會被一併算進收款金額，且不會報錯，只會靜默算錯。
function renderOrderItems(items) {
  if (items === null) {
    return '<div style="padding: 0.25rem 0 0; font-size: 0.8rem; color: var(--danger);">明細載入失敗</div>';
  }
  if (items.length === 0) {
    return '<div class="text-muted" style="padding: 0.25rem 0 0; font-size: 0.8rem;">此單據沒有明細。</div>';
  }

  return `
    <table class="detail-table">
      <thead>
        <tr>
          <th>商品</th>
          <th>數量</th>
          <th>單價</th>
          <th>小計</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td>${escapeHtml(item.products?.name ?? '')} <span class="text-muted">(${escapeHtml(item.products?.sku ?? '')})</span></td>
            <td>${Math.abs(item.qty)} ${escapeHtml(item.products?.unit ?? '')}</td>
            <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(item.unit_price)}</td>
            <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(item.subtotal)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// 明細預設全部展開，所以一次撈完：每列各發一次查詢，清單一開就是十幾個 round-trip。
// 撈不到不讓整張清單陣亡——該列顯示「明細載入失敗」，勾選與金額照常運作。
async function loadOrderItems(orderIds) {
  if (orderIds.length === 0) return new Map();

  try {
    const { data, error } = await sb
      .from('order_items')
      .select('*, products(name, sku, unit)')
      .in('order_id', orderIds);

    if (error) throw error;

    const grouped = new Map(orderIds.map(id => [id, []]));
    (data || []).forEach(item => grouped.get(item.order_id)?.push(item));
    return grouped;
  } catch (error) {
    console.error('Error loading order items:', error);
    showToast('載入單據明細失敗：' + toErrorMessage(error), 'error');
    // 空 Map：renderOrderItems 收到 null 會顯示失敗提示，不會誤標成「沒有明細」。
    return new Map();
  }
}

async function loadAllocatableOrders(partnerId, payment = null) {
  if (!partnerId) {
    paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">請先選擇客戶</div>';
    setLegacyLock(null);
    updatePaymentAmount();
    return;
  }

  paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">載入中...</div>';

  try {
    const [outstandingRes, existingRes] = await Promise.all([
      sb.from('outstanding_order_view').select('*').eq('partner_id', partnerId).order('order_date'),
      payment
        ? sb.from('payment_allocation_view').select('*').eq('payment_id', payment.id).order('order_date')
        : Promise.resolve({ data: [], error: null })
    ]);

    if (outstandingRes.error) throw outstandingRes.error;
    if (existingRes.error) throw existingRes.error;

    const existing = existingRes.data || [];
    const existingById = new Map(existing.map(e => [e.order_id, e]));

    // 編輯時，這筆收款自己已分配的金額會讓單據看起來未收較少，
    // 必須加回去才是「這筆收款可以動用的上限」，也才是勾選時要帶入的金額。
    let rows = (outstandingRes.data || []).map(o => {
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

    const legacy = isLegacyAllocation(rows, payment) ? payment : null;
    setLegacyLock(legacy);

    // 舊制唯讀時只列出這筆收款實際沖過的單：其餘未收單既然不能勾，列出來只是雜訊。
    if (legacy) rows = rows.filter(r => r.allocated > 0);

    if (rows.length === 0) {
      paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0;">此客戶目前沒有未收款的出貨單</div>';
      updatePaymentAmount();
      return;
    }

    rows.sort((a, b) => (a.order_date < b.order_date ? -1 : a.order_date > b.order_date ? 1 : 0));

    const itemsByOrder = await loadOrderItems(rows.map(r => r.id));
    paymentOrdersList.innerHTML = rows
      .map(r => renderAllocationRow(r, Boolean(legacy), itemsByOrder.get(r.id) ?? null))
      .join('');

    bindAllocationEvents();
    updatePaymentAmount();
  } catch (error) {
    console.error('Error loading orders:', error);
    paymentOrdersList.innerHTML = '<div class="empty-state" style="padding: 1rem 0; color: var(--danger);">載入失敗</div>';
    showToast('載入出貨單失敗：' + toErrorMessage(error), 'error');
  }
}

function bindAllocationEvents() {
  document.querySelectorAll('.allocation-row').forEach(row => {
    const checkbox = row.querySelector('.order-checkbox');
    if (checkbox.disabled) return;
    checkbox.addEventListener('change', updatePaymentAmount);
  });
}

// 收款金額是勾選結果的推導值，不由使用者輸入。
// 舊制唯讀時維持原本存下的金額：那筆金額可能大於分配總額（未分配預收），
// 用加總覆寫會讓差額憑空消失。
function updatePaymentAmount() {
  let total;

  if (legacyPayment) {
    total = round2(Number(legacyPayment.amount) || 0);
  } else {
    total = 0;
    document.querySelectorAll('.allocation-row').forEach(row => {
      if (!row.querySelector('.order-checkbox').checked) return;
      total += Number(row.getAttribute('data-amount')) || 0;
    });
    total = round2(total);
  }

  paymentAmount.value = total;
  paymentAmountDisplay.textContent = formatCurrency(total);
}

function collectAllocations() {
  const allocations = [];
  document.querySelectorAll('.allocation-row').forEach(row => {
    if (!row.querySelector('.order-checkbox').checked) return;

    const amount = round2(Number(row.getAttribute('data-amount')));
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
  // 先解鎖：上一次開的可能是舊制收款，殘留的鎖會讓客戶下拉一直停在 disabled。
  setLegacyLock(null);
  updatePaymentAmount();

  if (payment) {
    document.getElementById('payment-modal-title').textContent = '編輯收款';
    document.getElementById('payment-id').value = payment.id;
    paymentPartner.value = payment.partner_id;
    document.getElementById('payment-date').value = payment.payment_date;
    document.getElementById('payment-method').value = payment.method;
    document.getElementById('payment-note').value = payment.note || '';
    renderPartnerBalanceHint(payment.partner_id);
    loadAllocatableOrders(payment.partner_id, payment);
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

  const allocations = collectAllocations();
  if (allocations.length === 0) {
    showToast('請勾選這次收款結清的出貨單', 'error');
    return;
  }

  const amount = round2(Number(paymentAmount.value));
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
  balancePage = 1;
  loadPayments();
  loadBalances();
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
    const defaultRange = dateRange('last30Days');
    searchDateFrom.value = defaultRange.from;
    searchDateTo.value = defaultRange.to;
    searchPartner.value = 'all';
    searchMethod.value = 'all';
    searchKeyword.value = '';
    balanceKeyword.value = '';
    orderFilterId = null;
    orderFilterNo = null;
    orderFilterPartnerId = null;
    autoExpanded = false;
    currentPage = 1;
    balancePage = 1;
    loadPayments();
    loadBalances();
  });

  btnBalancePrev.addEventListener('click', () => {
    if (balancePage > 1) {
      balancePage--;
      loadBalances();
    }
  });

  btnBalanceNext.addEventListener('click', () => {
    if (balancePage < totalPages(balanceTotal)) {
      balancePage++;
      loadBalances();
    }
  });

  toggleSettled.addEventListener('change', () => {
    balancePage = 1;
    loadBalances();
  });

  balanceKeyword.addEventListener('input', debounce(() => {
    balancePage = 1;
    loadBalances();
  }, 400));

  document.getElementById('btn-add-payment').addEventListener('click', () => openPaymentModal());

  bindSubmitOnce('btn-save-payment', savePayment);

  paymentPartner.addEventListener('change', (e) => {
    const partnerId = e.target.value;
    const paymentId = document.getElementById('payment-id').value;
    const editing = paymentId ? currentPayments.find(p => p.id === paymentId) : null;

    // 換成別的客戶時不帶既有分配：那些單屬於原客戶，留著會被算進收款金額，
    // 儲存時才被 ALLOCATION_PARTNER_MISMATCH 擋下，金額卻早已顯示錯了。
    const payment = editing && editing.partner_id === partnerId ? editing : null;

    renderPartnerBalanceHint(partnerId);
    loadAllocatableOrders(partnerId, payment);
  });
}

requireAuth(init);
