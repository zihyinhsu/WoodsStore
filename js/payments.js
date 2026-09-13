import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce, onReady, renderPagination } from './ui.js';
import { PAGE_SIZE, formatCurrency, formatDate, toDateInputValue, dateRange, debounce, round2, totalPages, escapeHtml } from './utils.js';

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
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${message}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(b => {
    const balance = Number(b.balance);
    const credit = Number(b.unallocated_credit);
    return `
      <tr>
        <td>${escapeHtml(b.partner_no || '-')}</td>
        <td>${escapeHtml(b.name)}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_sales)}</td>
        <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(b.total_paid)}</td>
        <td style="font-family: 'Roboto', sans-serif;" class="${credit > 0 ? 'text-warning' : 'text-muted'}">
          ${formatCurrency(b.unallocated_credit)}
        </td>
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

function renderPaymentsTable() {
  const tbody = document.querySelector('#payments-table tbody');
  if (currentPayments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">找不到收款紀錄</td></tr>';
    return;
  }

  tbody.innerHTML = currentPayments.map(p => {
    const unallocated = Number(p.unallocated_amount) || 0;
    return `
    <tr class="clickable-row" data-id="${escapeHtml(p.id)}">
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

// status=all 不可省略：單據頁預設只列有效單據，作廢的單會直接搜不到而顯示空白。
// expand=1 讓對方頁面在命中單筆時自動展開明細，省去到站後再點一次。
function orderSearchLink(orderNo) {
  if (!orderNo) return '-';
  const href = `orders.html?q=${encodeURIComponent(orderNo)}&status=all&expand=1`;
  return `<a href="${escapeHtml(href)}" title="在單據管理中查看此單">${escapeHtml(orderNo)}</a>`;
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
      ? '<tr><td colspan="4" class="empty-state">此筆收款尚未沖帳，全額列為預收。</td></tr>'
      : rows.map(a => `
          <tr class="${a.order_id === orderFilterId ? 'is-highlighted' : ''}">
            <td>${formatDate(a.order_date)}</td>
            <td>${orderSearchLink(a.order_no)}</td>
            <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(a.order_total)}</td>
            <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(a.allocated_amount)}</td>
          </tr>`).join('');

    rowElement.insertAdjacentHTML('afterend', `
      <tr class="detail-row">
        <td colspan="8" style="padding: 1rem 2rem;">
          <h4 style="margin: 0 0 0.5rem;">沖帳明細</h4>
          <table class="detail-table">
            <thead>
              <tr>
                <th>出貨日期</th>
                <th>出貨單號</th>
                <th>單據金額</th>
                <th>本次沖帳</th>
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
    showToast('載入沖帳明細失敗：' + toErrorMessage(error), 'error');
  }
}

// 這裡必須單筆查詢，不能沿用餘額表的資料：餘額表已改為分頁 + 可篩選，
// 選到不在當頁的客戶會查不到，提示會無聲消失——而那正是決定沖帳金額的依據。
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
           style="padding: 0.5rem; border-bottom: 1px solid var(--border-light);">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
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
          <button type="button" class="btn btn-outline btn-toggle-items" aria-expanded="false"
                  style="padding: 0.25rem 0.5rem; font-size: 0.8rem; white-space: nowrap;">明細</button>
        </div>
        <div class="allocation-items" hidden></div>
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

// 明細必須維持純展示：這個容器裡若出現任何 input，collectAllocations 與
// updateAllocatedTotal 會把它一併算進沖帳金額，且不會報錯，只會靜默算錯。
async function toggleAllocationDetail(row) {
  const container = row.querySelector('.allocation-items');
  const button = row.querySelector('.btn-toggle-items');

  if (!container.hidden) {
    container.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    return;
  }

  container.hidden = false;
  button.setAttribute('aria-expanded', 'true');

  if (container.dataset.loaded === 'true') return;

  // 連點時第二次請求會在第一次回來前發出，用 token 確保只有最後一次的結果會被寫入。
  const token = Symbol('allocation-detail');
  row.__itemsToken = token;
  container.innerHTML = '<div class="text-muted" style="padding: 0.5rem 0; font-size: 0.85rem;">載入中...</div>';

  try {
    const { data, error } = await sb
      .from('order_items')
      .select('*, products(name, sku, unit)')
      .eq('order_id', row.getAttribute('data-id'));

    if (error) throw error;
    if (row.__itemsToken !== token) return;

    const items = data || [];
    container.dataset.loaded = 'true';
    container.innerHTML = items.length === 0
      ? '<div class="text-muted" style="padding: 0.5rem 0; font-size: 0.85rem;">此單據沒有明細。</div>'
      : `
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
  } catch (error) {
    console.error('Error loading order items:', error);
    if (row.__itemsToken !== token) return;
    // 不設 loaded，讓使用者收合後再展開可重試。
    container.innerHTML = '<div style="padding: 0.5rem 0; font-size: 0.85rem; color: var(--danger);">載入明細失敗</div>';
    showToast('載入單據明細失敗：' + toErrorMessage(error), 'error');
  }
}

function bindAllocationEvents() {
  document.querySelectorAll('.allocation-row').forEach(row => {
    const checkbox = row.querySelector('.order-checkbox');
    const input = row.querySelector('.allocation-amount');
    const allocatable = Number(row.getAttribute('data-allocatable'));

    row.querySelector('.btn-toggle-items').addEventListener('click', () => toggleAllocationDetail(row));

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
    renderPartnerBalanceHint(partnerId);
    loadAllocatableOrders(partnerId, paymentId || null);
  });

  paymentAmount.addEventListener('input', updateAllocatedTotal);

  btnAutoAllocate.addEventListener('click', autoAllocate);
}

onReady(init);
