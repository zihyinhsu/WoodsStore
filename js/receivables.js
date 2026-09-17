import { sb } from './supabase.js';
import { showToast, renderPagination, setupResponsiveTable } from './ui.js';
import { requireAuth } from './auth.js';
import {
  PAGE_SIZE, formatCurrency, formatDate, debounce, totalPages, escapeHtml, orderSearchLink
} from './utils.js';

let currentPage = 1;
let totalCount = 0;

const searchBucket = document.getElementById('search-bucket');
const searchKeyword = document.getElementById('search-keyword');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');

// 到期狀態由 receivable_followup_view 的 due_bucket 算好（含台北時區換算），
// 前端只負責顯示，不重算「今天」——兩邊各算一次遲早會不一致。
const BUCKET_BADGES = {
  overdue: '<span class="badge badge-red">已逾期</span>',
  today: '<span class="badge badge-orange">今天到期</span>',
  upcoming: '<span class="badge badge-blue">尚未到期</span>',
  unscheduled: '<span class="badge badge-gray">未設定</span>'
};

async function init() {
  setupResponsiveTable('#receivables-table');

  const urlParams = new URLSearchParams(window.location.search);
  searchBucket.value = urlParams.get('bucket') || 'all';
  searchKeyword.value = urlParams.get('q') || '';
  currentPage = parseInt(urlParams.get('page')) || 1;

  await loadReceivables();
  setupEventListeners();
}

function updateUrlParams() {
  const urlParams = new URLSearchParams();
  if (searchBucket.value !== 'all') urlParams.set('bucket', searchBucket.value);
  if (searchKeyword.value) urlParams.set('q', searchKeyword.value);
  if (currentPage > 1) urlParams.set('page', currentPage);

  const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
  window.history.replaceState({}, '', newUrl);
}

async function loadReceivables() {
  updateUrlParams();
  try {
    let query = sb.from('receivable_followup_view').select('*', { count: 'exact' });

    if (searchBucket.value !== 'all') {
      query = query.eq('due_bucket', searchBucket.value);
    }

    const keyword = sanitizeKeyword(searchKeyword.value);
    if (keyword) {
      // or() 的條件是以逗號分隔的字串，使用者輸入的逗號與括號會被當成語法而拆壞查詢，
      // 因此先由 sanitizeKeyword 去掉；這是 PostgREST 版的跳脫，與 escapeHtml 各司其職。
      query = query.or(
        `partner_name.ilike.%${keyword}%,partner_no.ilike.%${keyword}%,order_no.ilike.%${keyword}%`
      );
    }

    // 最急的排最前：逾期日期最早者優先，未設定收款日的排到最後（nullsFirst: false）。
    // 同一天到期再依出貨日排序，讓順序穩定、翻頁不會跳動。
    const from = (currentPage - 1) * PAGE_SIZE;
    query = query
      .order('expected_payment_date', { ascending: true, nullsFirst: false })
      .order('order_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    totalCount = count;
    renderTable(data || []);
    renderPagination({ page: currentPage, total: totalCount, pageSize: PAGE_SIZE, unit: '筆' });
  } catch (error) {
    console.error('Error loading receivables:', error);
    showToast('載入追款清單失敗: ' + error.message, 'error');
  }
}

// PostgREST 的 or() 以逗號切條件、以括號分群，這些字元出現在關鍵字裡會讓查詢語法錯亂。
// 百分比與底線則是 like 的通配符，留著會讓使用者輸入 % 意外比對到全部資料。
function sanitizeKeyword(value) {
  return String(value || '').trim().replace(/[(),%_\\]/g, '');
}

function renderTable(rows) {
  const tbody = document.querySelector('#receivables-table tbody');

  if (rows.length === 0) {
    const isFiltered = searchBucket.value !== 'all' || searchKeyword.value;
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${
      isFiltered ? '沒有符合條件的未收款項' : '目前沒有未收款項'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>
        ${row.expected_payment_date ? escapeHtml(formatDate(row.expected_payment_date)) : '-'}
        ${renderDueDetail(row)}
      </td>
      <td>${BUCKET_BADGES[row.due_bucket] || ''}</td>
      <td>${escapeHtml(row.partner_name || '-')}</td>
      <td>${orderSearchLink(row.order_no, row.order_date)}</td>
      <td>${escapeHtml(formatDate(row.order_date))}</td>
      <td style="font-family: 'Roboto', sans-serif;">${escapeHtml(formatCurrency(row.order_total))}</td>
      <td style="font-family: 'Roboto', sans-serif;">${escapeHtml(formatCurrency(row.paid_amount))}</td>
      <td style="font-family: 'Roboto', sans-serif; font-weight: 600;">${escapeHtml(formatCurrency(row.outstanding_amount))}</td>
      <td>
        <a href="payments.html?order_id=${encodeURIComponent(row.order_id)}"
           class="btn btn-outline" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;"
           title="為此單據登錄收款">登錄收款</a>
      </td>
    </tr>
  `).join('');
}

// days_past_due 為正代表已逾期、為負代表距到期天數、null 代表未約定收款日。
function renderDueDetail(row) {
  const days = row.days_past_due;
  if (days === null || days === undefined) {
    return '<span class="due-detail due-detail--muted">尚未約定收款日</span>';
  }
  if (days > 0) {
    return `<span class="due-detail due-detail--overdue">已逾期 ${escapeHtml(days)} 天</span>`;
  }
  if (days === 0) {
    return '<span class="due-detail due-detail--overdue">今天到期</span>';
  }
  return `<span class="due-detail due-detail--muted">還有 ${escapeHtml(-days)} 天</span>`;
}

function setupEventListeners() {
  searchBucket.addEventListener('change', () => {
    currentPage = 1;
    loadReceivables();
  });

  searchKeyword.addEventListener('input', debounce(() => {
    currentPage = 1;
    loadReceivables();
  }, 300));

  btnPrevPage.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadReceivables();
    }
  });

  btnNextPage.addEventListener('click', () => {
    if (currentPage < totalPages(totalCount)) {
      currentPage++;
      loadReceivables();
    }
  });
}

requireAuth(init);
