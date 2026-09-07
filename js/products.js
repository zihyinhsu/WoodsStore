import { sb } from './supabase.js';
import { formatCurrency, debounce, showToast, openModal, closeModal } from './ui.js';

const PAGE_SIZE = 20;
let currentProducts = [];
let currentPage = 1;
let totalCount = 0;

async function loadProducts(keyword = '') {
  try {
    const from = (currentPage - 1) * PAGE_SIZE;
    let query = sb.from('stock_view')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (keyword) {
      query = query.or(`name.ilike.%${keyword}%,sku.ilike.%${keyword}%,barcode.ilike.%${keyword}%,category.ilike.%${keyword}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    currentProducts = data;
    totalCount = count || 0;
    renderProductsTable(data);
    renderPagination();
  } catch (error) {
    console.error('Error loading products:', error);
    showToast('載入商品失敗: ' + error.message, 'error');
  }
}

function renderPagination() {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
  document.getElementById('page-info').textContent =
    `第 ${currentPage} / ${totalPages} 頁 (共 ${totalCount} 筆)`;
  document.getElementById('btn-prev-page').disabled = currentPage <= 1;
  document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
}

function renderProductsTable(products) {
  const tbody = document.querySelector('#products-table tbody');
  if (products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">找不到商品</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => `
    <tr>
      <td>${p.sku}</td>
      <td>
        <div>${p.name}</div>
        ${p.spec ? `<small class="text-muted">${p.spec}</small>` : ''}
      </td>
      <td>${p.category || '-'}</td>
      <td>
        <span class="${p.stock_qty < p.safety_stock ? 'text-danger font-weight-bold' : ''}">
          ${p.stock_qty} ${p.unit}
        </span>
      </td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.cost)}</td>
      <td style="font-family: 'Roboto', sans-serif;">${formatCurrency(p.price)}</td>
      <td>
        ${p.is_active 
          ? '<span class="badge badge-green">啟用</span>' 
          : '<span class="badge badge-gray">停用</span>'}
      </td>
      <td>
        <button class="btn btn-outline btn-edit" data-id="${p.id}">編輯</button>
      </td>
    </tr>
  `).join('');

  // Attach edit events
  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.getAttribute('data-id');
      const product = currentProducts.find(p => p.id === id);
      if (product) openEditModal(product);
    });
  });
}

function openEditModal(product = null) {
  const form = document.getElementById('product-form');
  form.reset();
  
  if (product) {
    document.getElementById('modal-title').textContent = '編輯商品';
    document.getElementById('product-id').value = product.id;
    document.getElementById('product-sku').value = product.sku || '';
    document.getElementById('product-barcode').value = product.barcode || '';
    document.getElementById('product-name').value = product.name || '';
    document.getElementById('product-category').value = product.category || '';
    document.getElementById('product-unit').value = product.unit || '個';
    document.getElementById('product-cost').value = product.cost || 0;
    document.getElementById('product-price').value = product.price || 0;
    document.getElementById('product-safety-stock').value = product.safety_stock || 0;
    document.getElementById('product-location').value = product.location || '';
    document.getElementById('product-tax-type').value = product.tax_type || 'taxable';
    document.getElementById('product-is-active').value = product.is_active ? 'true' : 'false';
    document.getElementById('product-spec').value = product.spec || '';
  } else {
    document.getElementById('modal-title').textContent = '新增商品';
    document.getElementById('product-id').value = '';
  }
  
  openModal('product-modal');
}

async function saveProduct() {
  const form = document.getElementById('product-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const id = document.getElementById('product-id').value;
  const productData = {
    sku: document.getElementById('product-sku').value,
    barcode: document.getElementById('product-barcode').value || null,
    name: document.getElementById('product-name').value,
    category: document.getElementById('product-category').value || null,
    unit: document.getElementById('product-unit').value || '個',
    cost: parseFloat(document.getElementById('product-cost').value) || 0,
    price: parseFloat(document.getElementById('product-price').value) || 0,
    safety_stock: parseInt(document.getElementById('product-safety-stock').value) || 0,
    location: document.getElementById('product-location').value || null,
    tax_type: document.getElementById('product-tax-type').value,
    is_active: document.getElementById('product-is-active').value === 'true',
    spec: document.getElementById('product-spec').value || null
  };

  try {
    let error;
    if (id) {
      const res = await sb.from('products').update(productData).eq('id', id);
      error = res.error;
    } else {
      const res = await sb.from('products').insert([productData]);
      error = res.error;
    }

    if (error) throw error;

    showToast(id ? '商品更新成功' : '商品新增成功', 'success');
    closeModal('product-modal');
    loadProducts(document.getElementById('search-input').value);
  } catch (error) {
    console.error('Error saving product:', error);
    showToast('儲存失敗: ' + error.message, 'error');
  }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  loadProducts();

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', debounce((e) => {
    currentPage = 1;
    loadProducts(e.target.value);
  }, 300));

  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadProducts(searchInput.value);
    }
  });

  document.getElementById('btn-next-page').addEventListener('click', () => {
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage++;
      loadProducts(searchInput.value);
    }
  });

  document.getElementById('btn-add-product').addEventListener('click', () => {
    openEditModal();
  });

  document.getElementById('btn-save-product').addEventListener('click', saveProduct);
});
