import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce, renderPagination, setupResponsiveTable, printSlips, setupPrintSelection } from './ui.js';
import { requireAuth } from './auth.js';
import { PAGE_SIZE, formatCurrency, formatDate, toDateInputValue, dateRange, debounce, totalPages, escapeHtml, itemSummary, round2, groupBy } from './utils.js';

let currentPage = 1;
let totalCount = 0;
let currentRows = [];          // 本頁的列：{ group, members }，逐張顯示時 group 為 null、members 只有一張
let ordersById = new Map();    // 本頁載入的所有單據（含收在組裡的接續單），編輯、列印、展開都從這裡取
let productsCache = [];
let partnersCache = [];
let editingOrderId = null;
let editingOrderStatus = null;
let editingParentId = null;
let parentOptionsRequest = 0;
let detailRequest = 0;
let pendingAutoExpand = false;
let printSelection = null;

// DOM Elements
const searchDateFrom = document.getElementById('search-date-from');
const searchDateTo = document.getElementById('search-date-to');
const searchType = document.getElementById('search-type');
const searchStatus = document.getElementById('search-status');
const searchPayment = document.getElementById('search-payment');
const searchKeyword = document.getElementById('search-keyword');
const searchView = document.getElementById('search-view');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');

async function init() {
  setupResponsiveTable('#orders-table');
  printSelection = setupPrintSelection({
    table: '#orders-table',
    printLabel: '列印出貨單',
    getItem: id => ordersById.get(id),
    onPrint: printShippingOrders
  });

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
  searchView.value = urlParams.get('view') === 'flat' ? 'flat' : 'group';
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
  if (searchView.value === 'flat') urlParams.set('view', 'flat');
  if (currentPage > 1) urlParams.set('page', currentPage);
  
  const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
  window.history.replaceState({}, '', newUrl);
}

async function loadOrders() {
  updateUrlParams();
  try {
    const { rows, count } = searchView.value === 'flat' ? await fetchOrderRows() : await fetchGroupRows();

    currentRows = rows;
    ordersById = new Map(rows.flatMap(r => r.members).map(o => [o.id, o]));
    totalCount = count;

    renderOrdersTable();
    updatePagination();
    autoExpandSingleResult();
  } catch (error) {
    console.error('Error loading orders:', error);
    showToast('載入單據失敗: ' + error.message, 'error');
  }
}

// 逐張顯示：一張單一列。
async function fetchOrderRows() {
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
  // view 只對已確認的出貨單（應收）與進貨單（應付）給值，其餘給 null，
  // 所以下了條件就自動排除調整／草稿／作廢單；要只看應收或應付，搭配類型條件即可。
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

  return { rows: (data || []).map(order => ({ group: null, members: [order] })), count };
}

// 合併顯示：接續同一張原單的分批單據合成一列（patch-029）。
// 篩選與分頁必須以組為單位在 SQL 做：前端藏掉接續單會讓每頁張數錯亂，
// 日期區間只命中 B 時 A 又被濾掉，整組就消失了。各條件套用的層級見 search_order_groups 的註解。
async function fetchGroupRows() {
  const statuses = { active: ['draft', 'confirmed'], all: null }[searchStatus.value]
    ?? [searchStatus.value];

  const { data: groups, error } = await sb.rpc('search_order_groups', {
    p_date_from: searchDateFrom.value || null,
    p_date_to: searchDateTo.value || null,
    p_type: searchType.value === 'all' ? null : searchType.value,
    p_statuses: statuses,
    p_payment: searchPayment.value === 'all' ? null : searchPayment.value,
    p_keyword: searchKeyword.value || null,
    p_limit: PAGE_SIZE,
    p_offset: (currentPage - 1) * PAGE_SIZE
  });
  if (error) throw error;

  // 從逐張模式或舊網址帶來的頁碼可能超過組數（組數必然較少），退回第一頁而不是顯示空白。
  if ((groups || []).length === 0 && currentPage > 1) {
    currentPage = 1;
    return fetchGroupRows();
  }

  const ids = (groups || []).flatMap(g => g.member_ids);
  let members = [];
  if (ids.length > 0) {
    const { data, error: membersError } = await sb.from('order_search_view').select('*').in('id', ids);
    if (membersError) throw membersError;
    members = data || [];
  }
  const byId = new Map(members.map(o => [o.id, o]));

  // 兩次查詢之間單據可能剛被作廢或刪除，查不到的成員直接略過，不讓整頁失敗。
  const rows = (groups || [])
    .map(group => ({ group, members: group.member_ids.map(id => byId.get(id)).filter(Boolean) }))
    .filter(row => row.members.length > 0);

  return { rows, count: Number(groups?.[0]?.total_count) || 0 };
}

// 只在命中單筆時展開：q 是對 search_text 模糊比對，也會命中備註等欄位，
// 多筆全開會把使用者真正要看的那張單淹沒。
// 旗標用後即清，否則之後每次改搜尋條件都會再自己彈開一次。
// 合併顯示時命中的是整組，展開後即可看到目標那批。
function autoExpandSingleResult() {
  if (!pendingAutoExpand) return;
  pendingAutoExpand = false;

  if (currentRows.length !== 1) return;

  const row = document.querySelector('#orders-table .clickable-row');
  if (row) toggleRowDetail(row);
}

const TYPE_BADGES = {
  'purchase': '<span class="badge badge-blue">進貨</span>',
  'sale': '<span class="badge badge-green">出貨</span>',
  'adjust': '<span class="badge badge-orange">調整</span>'
};

// data-status 讓樣式與測試不必靠欄位位置定位（類型與狀態同格，索引不再對得上欄名）。
const STATUS_BADGES = {
  'draft': '<span class="badge badge-gray" data-status="draft">草稿</span>',
  'confirmed': '<span class="badge badge-green" data-status="confirmed">已確認</span>',
  'void': '<span class="badge badge-red" data-status="void">已作廢</span>'
};

const PAYMENT_LABELS = {
  'unpaid': '<span class="text-danger">未付款</span>',
  'partial': '<span class="text-warning">部分付款</span>',
  'paid': '<span class="text-success">已付款</span>'
};

const ACTION_BTN_STYLE = 'padding: 0.25rem 0.5rem; font-size: 0.8rem;';

const hasPaymentStatus = (order) =>
  (order.type === 'sale' || order.type === 'purchase') && order.status === 'confirmed';

function paymentLabel(type, status, paidAmount) {
  const action = type === 'purchase' ? '付' : '收';
  const label = PAYMENT_LABELS[status] || PAYMENT_LABELS['unpaid'];
  const detail = status === 'partial'
    ? `<span class="text-muted" style="font-size: 0.8rem; display: block;">已${action} ${formatCurrency(Number(paidAmount || 0))}</span>`
    : '';
  return label + detail;
}

// 付款狀態由收付款紀錄推導（order_payment_summary_view），不可直接編輯。
// 點擊導向收付款管理並帶 order_id，讓使用者直接看到／建立對應的收款或付款；
// 方向由收付款頁依單據類型自行判斷，這裡不必帶 dir。
function paymentLink(order) {
  const action = order.type === 'purchase' ? '付' : '收';
  return `
    <a href="payments.html?order_id=${encodeURIComponent(order.id)}" class="payment-link"
       title="查看此單據的${action}款紀錄">${paymentLabel(order.type, order.payment_status, order.paid_amount)}</a>`;
}

// 分批進出貨（patch-028）：接續單標原單號、原單標張數，點了篩出整組。
// 合併顯示時多半已收成一列，只有成員被狀態條件濾到剩一張時才會看到。
function batchLink(order) {
  let label = '';
  if (order.parent_order_id) label = `接續 ${order.group_root_no}`;
  else if (Number(order.group_size) > 1) label = `共 ${Number(order.group_size)} 批`;
  if (!label) return '';
  return `
    <a href="#" class="payment-link batch-link" data-root-no="${escapeHtml(order.group_root_no)}"
       style="font-size: 0.8rem;" title="篩出同一批的單據">${escapeHtml(label)}</a>`;
}

function orderActionButtons(order) {
  const id = escapeHtml(order.id);
  const buttons = [];
  if (order.status === 'draft' || order.status === 'confirmed') {
    buttons.push(`<button class="btn btn-outline btn-edit" data-id="${id}" style="${ACTION_BTN_STYLE}">編輯</button>`);
  }
  if (order.status === 'draft') {
    buttons.push(`<button class="btn btn-primary btn-confirm" data-id="${id}" style="${ACTION_BTN_STYLE}">確認</button>`);
  }
  if (order.status !== 'void') {
    buttons.push(`<button class="btn btn-outline btn-void" data-id="${id}" style="${ACTION_BTN_STYLE}">作廢</button>`);
  }
  return buttons.join(' ');
}

function renderOrderRow(order) {
  return `
    <tr class="clickable-row" data-id="${escapeHtml(order.id)}">
      ${printSelection.checkboxCell(order.id, order.type === 'sale' && order.status !== 'void')}
      <td>${formatDate(order.order_date)}</td>
      <td>
        ${itemSummary(order.top_item_name, order.item_count)}
        <span class="text-muted" style="font-size: 0.8rem; display: block;">${escapeHtml(order.order_no)}</span>
        ${batchLink(order)}
      </td>
      <td>${TYPE_BADGES[order.type]} ${STATUS_BADGES[order.status]}</td>
      <td>${escapeHtml(order.partner_name || '-')}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(order.total_amount)}</td>
      <td>${hasPaymentStatus(order) ? paymentLink(order) : '-'}</td>
      <td>${orderActionButtons(order)}</td>
    </tr>
  `;
}

// 一組一列：同組必同往來對象（guard_order_parent），對象欄直接顯示供應商／客戶。
// 組列不放操作鈕：作廢、編輯、列印都是對單張單據，展開後在各批上操作。
// 付款狀態只顯示不連結：收付款頁的 order_id 只對應單張。
function renderGroupRow({ group, members }) {
  const root = members.find(o => o.id === group.group_root_id) || members[0];
  return `
    <tr class="clickable-row group-row" data-group-id="${escapeHtml(group.group_root_id)}">
      ${printSelection.checkboxCell(group.group_root_id, false)}
      <td>${formatDate(group.order_date)}</td>
      <td>
        ${itemSummary(root.top_item_name, root.item_count)}
        <span class="text-muted" style="font-size: 0.8rem; display: block;">
          ${escapeHtml(group.group_root_no)} 等 ${members.length} 批
        </span>
      </td>
      <td>${TYPE_BADGES[group.type]} <span class="badge badge-gray">${members.length} 批</span></td>
      <td>${escapeHtml(group.partner_name || '-')}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(group.total_amount)}</td>
      <td>${group.payment_status ? paymentLabel(group.type, group.payment_status, group.paid_amount) : '-'}</td>
      <td><span class="text-muted" style="font-size: 0.8rem;">展開後操作各批</span></td>
    </tr>
  `;
}

function renderOrdersTable() {
  const tbody = document.querySelector('#orders-table tbody');
  if (currentRows.length === 0) {
    // 從收款頁的沖帳明細跳來卻撲空，多半是單號被改過或該單已不存在，
    // 只寫「找不到單據」會讓人以為連結壞了。
    const hint = pendingAutoExpand
      ? `<div class="text-muted" style="font-size: 0.85rem; margin-top: 0.5rem;">
           找不到單號 ${escapeHtml(searchKeyword.value)}，該單據可能已被刪除或單號已變更。
         </div>`
      : '';
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">找不到單據${hint}</td></tr>`;
    return;
  }

  tbody.innerHTML = currentRows
    .map(row => (row.members.length > 1 ? renderGroupRow(row) : renderOrderRow(row.members[0])))
    .join('');

  document.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (e.target.closest('.col-pick')) return;
      if (e.target.closest('.payment-link')) return;
      toggleRowDetail(row);
    });
  });

  // 篩整組靠 search_text 併入的原單號（order_search_view），不另開查詢條件。
  // 日期與付款狀態一併清掉：分批到貨常跨月，原單又可能已付清，留著會把同組的單濾掉。
  document.querySelectorAll('.batch-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      searchKeyword.value = link.getAttribute('data-root-no');
      searchDateFrom.value = '';
      searchDateTo.value = '';
      searchPayment.value = 'all';
      currentPage = 1;
      loadOrders();
    });
  });

  bindOrderActions(tbody);
}

// 列表與展開區塊共用：組展開後各批也有自己的編輯／確認／作廢／列印。
function bindOrderActions(container) {
  container.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditOrder(btn.getAttribute('data-id'));
    });
  });

  container.querySelectorAll('.btn-confirm').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('確定要讓此草稿生效嗎？生效後將計入庫存。')) {
        await confirmOrder(btn.getAttribute('data-id'));
      }
    });
  });

  container.querySelectorAll('.btn-void').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('確定要作廢此單據嗎？庫存將會自動回沖。')) {
        await voidOrder(btn.getAttribute('data-id'));
      }
    });
  });

  container.querySelectorAll('.btn-print-shipping').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const order = ordersById.get(btn.getAttribute('data-id'));
      if (order) printShippingOrders([order]);
    });
  });
}

function toggleRowDetail(row) {
  if (row.classList.contains('group-row')) {
    const entry = currentRows.find(r => r.group?.group_root_id === row.getAttribute('data-group-id'));
    if (entry) toggleDetail(row, () => buildGroupDetail(entry.members));
  } else {
    const order = ordersById.get(row.getAttribute('data-id'));
    if (order) toggleDetail(row, () => buildOrderDetail(order));
  }
}

async function toggleDetail(rowElement, buildDetail) {
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

  // 連點三下時，第一次與第三次的載入會同時在跑，兩者回來時列都是展開狀態，
  // 只看 detail-open 會插入兩列明細。以序號只讓最後一次請求插入。
  const request = ++detailRequest;

  try {
    const html = await buildDetail();
    if (request !== detailRequest || !rowElement.classList.contains('detail-open')) return;

    rowElement.insertAdjacentHTML('afterend', `
      <tr class="detail-row">
        <td colspan="8" style="padding: 1rem 2rem;">${html}</td>
      </tr>
    `);
    bindOrderActions(rowElement.nextElementSibling);
  } catch (error) {
    if (request !== detailRequest) return;
    rowElement.classList.remove('detail-open');
    showToast('載入明細失敗：' + toErrorMessage(error), 'error');
  }
}

async function loadItemsByOrder(orderIds) {
  const { data, error } = await sb
    .from('order_items')
    .select('*, products(name, sku, spec, unit)')
    .in('order_id', orderIds);
  if (error) throw error;
  return groupBy(data || [], 'order_id');
}

function printButton(order) {
  if (order.type !== 'sale' || order.status === 'void') return '';
  return `<button class="btn btn-outline btn-print-shipping" data-id="${escapeHtml(order.id)}" style="${ACTION_BTN_STYLE}">列印出貨單</button>`;
}

function renderItemsTable(items) {
  return `
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
        ${items.map(item => `
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
  `;
}

async function buildOrderDetail(order) {
  const itemsByOrder = await loadItemsByOrder([order.id]);
  return `
    <div class="d-flex justify-between align-center mb-2">
      <h4 style="margin: 0;">單據明細</h4>
      ${printButton(order)}
    </div>
    ${renderItemsTable(itemsByOrder.get(order.id) || [])}
  `;
}

// 組展開：逐批列出，每批是獨立單據（各自的狀態、付款、操作與明細），
// 因為庫存與沖帳都以單張為單位，作廢 B 不能連帶作廢 A。
async function buildGroupDetail(members) {
  const itemsByOrder = await loadItemsByOrder(members.map(o => o.id));
  return members.map(order => `
    <div class="batch-block" data-id="${escapeHtml(order.id)}" style="margin-bottom: 1.25rem;">
      <div class="d-flex justify-between align-center mb-2" style="gap: 0.75rem; flex-wrap: wrap;">
        <div>
          <strong>${formatDate(order.order_date)}</strong>
          <span class="text-muted" style="margin: 0 0.5rem;">${escapeHtml(order.order_no)}</span>
          ${STATUS_BADGES[order.status]}
          ${order.parent_order_id ? '' : '<span class="badge badge-gray">原單</span>'}
        </div>
        <div class="d-flex align-center" style="gap: 0.75rem; flex-wrap: wrap;">
          <span style="font-family: 'Roboto', sans-serif;">${formatCurrency(order.total_amount)}</span>
          ${hasPaymentStatus(order) ? paymentLink(order) : ''}
          ${orderActionButtons(order)}
          ${printButton(order)}
        </div>
      </div>
      ${renderItemsTable(itemsByOrder.get(order.id) || [])}
    </div>
  `).join('');
}

// 明細與客戶資料一次撈齊再組版：多張一起印時逐張查詢會慢到列印對話框遲遲不出來。
// 回傳是否有開出列印，供勾選列印判斷要不要清除選取（見 ui.js 的 setupPrintSelection）。
async function printShippingOrders(orders) {
  const orderIds = orders.map(o => o.id);
  const partnerIds = [...new Set(orders.map(o => o.partner_id).filter(Boolean))];

  try {
    const [itemsRes, partnersRes] = await Promise.all([
      sb.from('order_items').select('*, products(name, spec, unit)').in('order_id', orderIds),
      partnerIds.length > 0
        ? sb.from('partners').select('*').in('id', partnerIds)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (itemsRes.error) throw itemsRes.error;
    if (partnersRes.error) throw partnersRes.error;

    const itemsByOrder = groupBy(itemsRes.data || [], 'order_id');
    const partnersById = new Map((partnersRes.data || []).map(p => [p.id, p]));

    printSlips(orders.map(order =>
      shippingSlipHtml(order, itemsByOrder.get(order.id) || [], partnersById.get(order.partner_id))));
    return true;
  } catch (error) {
    console.error('Error loading data for print:', error);
    showToast('載入列印資料失敗：' + toErrorMessage(error), 'error');
    return false;
  }
}

function shippingSlipHtml(order, items, partner) {
  return `
    <div class="print-doc-header">
      <h1>藝境裝璜材料行</h1>
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

const PARENT_HINT = '分批到貨時選擇原單，列表與付款時會歸為同一組';

// 回傳已跳脫的 HTML：itemSummary 本身就會跳脫品名。
function parentOptionHtml(o) {
  const voided = o.status === 'void' ? '（已作廢）' : '';
  return `${formatDate(o.order_date)} ${escapeHtml(o.order_no)}${voided}｜`
    + `${itemSummary(o.top_item_name, o.item_count)}｜${formatCurrency(o.total_amount)}`;
}

// 候選只列同類型、同對象、已確認的原單：接續單不能再被接續（兩層限制，見 guard_order_parent）。
// 規則以 DB trigger 為準，這裡只是不讓使用者選到注定會被擋的單。
// 切換往來對象時會連續觸發，用流水號丟棄過期的回應，免得選單被舊對象的結果蓋掉。
async function loadParentOptions(selectedId = '') {
  const group = document.getElementById('order-parent-group');
  const select = document.getElementById('order-parent');
  const type = document.getElementById('order-type').value;
  const partnerId = document.getElementById('order-partner').value;
  const request = ++parentOptionsRequest;

  group.hidden = type !== 'purchase' && type !== 'sale';
  select.innerHTML = '<option value="">（新的一批）</option>';
  select.value = '';
  if (group.hidden || !partnerId) return;

  try {
    const columns = 'id, order_no, order_date, status, top_item_name, item_count, total_amount';
    let query = sb.from('order_search_view')
      .select(columns)
      .eq('type', type)
      .eq('partner_id', partnerId)
      .eq('status', 'confirmed')
      .is('parent_order_id', null)
      .order('order_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50);
    if (editingOrderId) query = query.neq('id', editingOrderId);

    const { data, error } = await query;
    if (error) throw error;
    if (request !== parentOptionsRequest) return;

    const options = data || [];
    // 編輯既有接續單時，原單可能已作廢或早於近 50 筆，仍要顯示出來，否則一存檔就被解除接續。
    if (selectedId && !options.some(o => o.id === selectedId)) {
      const { data: current, error: currentError } = await sb.from('order_search_view')
        .select(columns).eq('id', selectedId).maybeSingle();
      if (currentError) throw currentError;
      if (request !== parentOptionsRequest) return;
      if (current) options.unshift(current);
    }

    select.innerHTML += options
      .map(o => `<option value="${escapeHtml(o.id)}">${parentOptionHtml(o)}</option>`)
      .join('');
    select.value = selectedId || '';
  } catch (error) {
    console.error('Error loading parent orders:', error);
    showToast('載入可接續的單據失敗：' + toErrorMessage(error), 'error');
  }
}

// 已有接續單的原單不能再去接續別人（ORDER_HAS_CHILDREN），直接鎖住並說明原因。
function setParentLocked(order) {
  const locked = Boolean(order && !order.parent_order_id && Number(order.group_size) > 1);
  document.getElementById('order-parent').disabled = locked;
  document.getElementById('order-parent-hint').textContent = locked
    ? '此單已有接續單，是這組的原單，不能再接續其他單'
    : PARENT_HINT;
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
    <input type="number" class="form-control line-price price-col" min="0" step="any" value="0" required>
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

  // 調整單改由商品頁「快速庫存調整」建立（語意用「目標庫存」比「差額」更直覺、不易填錯）。
  // option 仍保留在 DOM：既有調整單編輯時要靠它正確顯示型別，saveOrder 的 adjust
  // 豁免（type !== 'adjust'）也依賴這個值。這裡只在「新增單據」時把它藏起來，不讓再開新調整單。
  const adjustOption = document.querySelector('#order-type option[value="adjust"]');
  if (adjustOption) adjustOption.hidden = isCreate;

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
  const order = ordersById.get(orderId);
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

    editingParentId = order.parent_order_id || null;
    await loadParentOptions(editingParentId || '');
    setParentLocked(order);

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

async function saveConfirmedOrderMeta() {
  const parentId = document.getElementById('order-parent').value || null;

  try {
    const { error } = await sb.rpc('update_order_meta', {
      p_order_id: editingOrderId,
      p_note: document.getElementById('order-note').value || ''
    });
    if (error) throw error;
  } catch (error) {
    console.error('Error updating note:', error);
    showToast('更新失敗：' + toErrorMessage(error), 'error');
    return;
  }

  // 接續另走 set_order_parent（update_order_meta 的 null 代表不改，表達不了解除）。
  // 兩支不在同一個交易，備註已存成功時要講清楚是哪一項沒存到，並留在視窗讓使用者改。
  if (parentId !== editingParentId) {
    const { error } = await sb.rpc('set_order_parent', {
      p_order_id: editingOrderId,
      p_parent_order_id: parentId
    });
    if (error) {
      console.error('Error updating parent order:', error);
      showToast('備註已更新，但接續單據未更新：' + toErrorMessage(error), 'error');
      loadOrders();
      return;
    }
  }

  showToast('單據已更新', 'success');
  closeModal('order-modal');
  editingOrderId = null;
  editingOrderStatus = null;
  editingParentId = null;
  loadOrders();
}

async function saveOrder(status = 'confirmed') {
  // 已確認單據的表頭與明細欄位皆為 disabled，僅備註與接續單據可改，
  // 直接走 meta 更新以免誤用整張替換的 RPC。
  if (editingOrderId && editingOrderStatus === 'confirmed') {
    await saveConfirmedOrderMeta();
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
        unit_price: round2(row.querySelector('.line-price').value),
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
    p_tax: parseFloat(document.getElementById('order-tax').value) || 0,
    p_parent_order_id: document.getElementById('order-parent').value || null
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
    editingParentId = null;
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

  [searchDateFrom, searchDateTo, searchType, searchStatus, searchPayment, searchView].forEach(el => {
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
    editingParentId = null;
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
    loadParentOptions();
    setParentLocked(null);
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
    loadParentOptions();
    // Update prices for existing lines
    document.querySelectorAll('.line-product').forEach(select => {
      select.dispatchEvent(new Event('change'));
    });
  });

  // 原單必須同對象（guard_order_parent），換對象後原本選的原單已不成立。
  document.getElementById('order-partner').addEventListener('change', () => loadParentOptions());

  document.getElementById('btn-add-line').addEventListener('click', addLineItem);
  
  ['order-discount', 'order-tax'].forEach(id => {
    document.getElementById(id).addEventListener('input', calculateTotal);
  });

  bindSubmitOnce('btn-save-order', () => saveOrder('confirmed'));
  bindSubmitOnce('btn-save-draft', () => saveOrder('draft'));
}

requireAuth(init);
