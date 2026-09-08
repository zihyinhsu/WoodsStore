import { sb } from './supabase.js';
import { formatCurrency, formatDate, showToast } from './ui.js';

async function loadDashboard() {
  try {
    // 1. Total Products
    const { count: totalProducts, error: err1 } = await sb
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);
    if (err1) throw err1;
    document.getElementById('stat-total-products').textContent = totalProducts || 0;

    // 2. Low Stock Products
    const { data: lowStockData, error: err2 } = await sb
      .from('stock_view')
      .select('*')
      .eq('is_active', true);
    if (err2) throw err2;
    
    const lowStockItems = lowStockData.filter(p => p.stock_qty < p.safety_stock);
    document.getElementById('stat-low-stock').textContent = lowStockItems.length;

    renderLowStockTable(lowStockItems.slice(0, 5));

    // 3. Today's Sales
    const today = new Date().toISOString().split('T')[0];
    const { data: todaySales, error: err3 } = await sb
      .from('order_search_view')
      .select('total_amount')
      .eq('type', 'sale')
      .eq('status', 'confirmed')
      .eq('order_date', today);
    if (err3) throw err3;
    
    const todayTotal = todaySales.reduce((sum, order) => sum + Number(order.total_amount), 0);
    document.getElementById('stat-today-sales').textContent = formatCurrency(todayTotal);

    // 4. Recent Orders (Last 30 days, infinite scroll 6/batch)
    const { count: recentOrdersCount, error: err4 } = await sb
      .from('order_search_view')
      .select('*', { count: 'exact', head: true })
      .gte('order_date', recentSince());
    if (err4) throw err4;

    document.getElementById('stat-recent-orders').textContent = recentOrdersCount || 0;
    recentTotal = recentOrdersCount || 0;
    await loadMoreRecentOrders();

  } catch (error) {
    console.error('Dashboard error:', error);
    showToast('載入總覽資料失敗: ' + error.message, 'error');
  }
}

const RECENT_BATCH = 6;
let recentLoaded = 0;
let recentTotal = 0;
let recentLoading = false;

function recentSince() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}

async function loadMoreRecentOrders() {
  if (recentLoading || (recentTotal > 0 && recentLoaded >= recentTotal)) return;
  recentLoading = true;

  try {
    const { data, error } = await sb
      .from('order_search_view')
      .select('*')
      .gte('order_date', recentSince())
      .order('created_at', { ascending: false })
      .range(recentLoaded, recentLoaded + RECENT_BATCH - 1);
    if (error) throw error;

    appendRecentOrders(data, recentLoaded === 0);
    recentLoaded += data.length;
  } catch (error) {
    console.error('Error loading recent orders:', error);
    showToast('載入最新單據失敗: ' + error.message, 'error');
  } finally {
    recentLoading = false;
  }
}

function renderLowStockTable(items) {
  const tbody = document.querySelector('#low-stock-table tbody');
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">目前無庫存不足的商品</td></tr>';
    return;
  }

  tbody.innerHTML = items.map(item => `
    <tr>
      <td>
        <a href="products.html#search=${encodeURIComponent(item.sku)}" class="product-link">${item.name}</a>
        <span class="text-muted">(${item.sku})</span>
      </td>
      <td class="text-danger font-weight-bold">${item.stock_qty}</td>
      <td>${item.safety_stock}</td>
    </tr>
  `).join('');
}

function appendRecentOrders(orders, isFirstBatch) {
  const tbody = document.querySelector('#recent-orders-table tbody');

  if (isFirstBatch) {
    tbody.innerHTML = '';
    if (orders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">近期無單據</td></tr>';
      return;
    }
  }

  const typeMap = {
    'purchase': '<span class="badge badge-blue">進貨</span>',
    'sale': '<span class="badge badge-green">出貨</span>',
    'adjust': '<span class="badge badge-orange">調整</span>'
  };

  tbody.insertAdjacentHTML('beforeend', orders.map(order => `
    <tr class="order-row" data-order-no="${order.order_no}">
      <td>${formatDate(order.order_date)}</td>
      <td>${order.order_no}</td>
      <td>${typeMap[order.type] || order.type}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(order.total_amount)}</td>
    </tr>
  `).join(''));

  tbody.querySelectorAll('.order-row:not([data-bound])').forEach(row => {
    row.setAttribute('data-bound', '1');
    row.addEventListener('click', () => {
      window.location.href = `orders.html#q=${encodeURIComponent(row.getAttribute('data-order-no'))}&status=all`;
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();

  const scrollBox = document.getElementById('recent-orders-scroll');
  scrollBox.addEventListener('scroll', () => {
    if (scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 20) {
      loadMoreRecentOrders();
    }
  });
});
