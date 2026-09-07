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

    // 4. Recent Orders (Last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

    const { data: recentOrders, count: recentOrdersCount, error: err4 } = await sb
      .from('order_search_view')
      .select('*', { count: 'exact' })
      .gte('order_date', thirtyDaysAgoStr)
      .order('created_at', { ascending: false })
      .limit(10);
    if (err4) throw err4;

    document.getElementById('stat-recent-orders').textContent = recentOrdersCount || 0;
    renderRecentOrdersTable(recentOrders);

  } catch (error) {
    console.error('Dashboard error:', error);
    showToast('載入總覽資料失敗: ' + error.message, 'error');
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
      <td>${item.name} <span class="text-muted">(${item.sku})</span></td>
      <td class="text-danger font-weight-bold">${item.stock_qty}</td>
      <td>${item.safety_stock}</td>
    </tr>
  `).join('');
}

function renderRecentOrdersTable(orders) {
  const tbody = document.querySelector('#recent-orders-table tbody');
  if (orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">近期無單據</td></tr>';
    return;
  }

  const typeMap = {
    'purchase': '<span class="badge badge-blue">進貨</span>',
    'sale': '<span class="badge badge-green">出貨</span>',
    'adjust': '<span class="badge badge-orange">調整</span>'
  };

  tbody.innerHTML = orders.map(order => `
    <tr>
      <td>${formatDate(order.order_date)}</td>
      <td>${order.order_no}</td>
      <td>${typeMap[order.type] || order.type}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(order.total_amount)}</td>
    </tr>
  `).join('');
}

document.addEventListener('DOMContentLoaded', loadDashboard);
