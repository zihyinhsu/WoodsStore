import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce, renderPagination, setupResponsiveTable } from './ui.js';
import { requireAuth } from './auth.js';
import { PAGE_SIZE, totalPages, escapeHtml } from './utils.js';

let currentPartners = [];
let currentType = 'supplier';
let currentPage = 1;
let totalCount = 0;

async function loadPartners() {
  try {
    const from = (currentPage - 1) * PAGE_SIZE;
    const { data, error, count } = await sb
      .from('partners')
      .select('*', { count: 'exact' })
      .eq('type', currentType)
      .order('partner_no', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;

    currentPartners = data;
    totalCount = count || 0;
    renderPartnersTable(data);
    renderPagination({ page: currentPage, total: totalCount, pageSize: PAGE_SIZE });
  } catch (error) {
    console.error('Error loading partners:', error);
    showToast('載入往來對象失敗: ' + error.message, 'error');
  }
}

function renderPartnersTable(partners) {
  const tbody = document.querySelector('#partners-table tbody');
  if (partners.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">找不到資料</td></tr>';
    return;
  }

  tbody.innerHTML = partners.map(p => `
    <tr>
      <td>${escapeHtml(p.partner_no || '-')}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.tax_id || '-')}</td>
      <td>${escapeHtml(p.contact_name || '-')}</td>
      <td>${escapeHtml(p.phone || '-')}</td>
      <td>${escapeHtml(p.payment_terms || '-')}</td>
      <td>
        <button class="btn btn-outline btn-edit" data-id="${p.id}">編輯</button>
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.getAttribute('data-id');
      const partner = currentPartners.find(p => p.id === id);
      if (partner) openEditModal(partner);
    });
  });
}

function openEditModal(partner = null) {
  const form = document.getElementById('partner-form');
  form.reset();
  
  if (partner) {
    document.getElementById('modal-title').textContent = '編輯對象';
    document.getElementById('partner-id').value = partner.id;
    document.getElementById('partner-type').value = partner.type;
    document.getElementById('partner-no').value = partner.partner_no || '';
    document.getElementById('partner-name').value = partner.name || '';
    document.getElementById('partner-tax-id').value = partner.tax_id || '';
    document.getElementById('partner-contact-name').value = partner.contact_name || '';
    document.getElementById('partner-phone').value = partner.phone || '';
    document.getElementById('partner-payment-terms').value = partner.payment_terms || '';
    document.getElementById('partner-address').value = partner.address || '';
    document.getElementById('partner-note').value = partner.note || '';
  } else {
    document.getElementById('modal-title').textContent = '新增對象';
    document.getElementById('partner-id').value = '';
    document.getElementById('partner-type').value = currentType;
  }

  document.getElementById('partner-no-hint').style.display = partner ? 'none' : '';

  openModal('partner-modal');
}

async function savePartner() {
  const form = document.getElementById('partner-form');
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const id = document.getElementById('partner-id').value;
  const partnerData = {
    type: document.getElementById('partner-type').value,
    partner_no: document.getElementById('partner-no').value || null,
    name: document.getElementById('partner-name').value,
    tax_id: document.getElementById('partner-tax-id').value || null,
    contact_name: document.getElementById('partner-contact-name').value || null,
    phone: document.getElementById('partner-phone').value || null,
    payment_terms: document.getElementById('partner-payment-terms').value || null,
    address: document.getElementById('partner-address').value || null,
    note: document.getElementById('partner-note').value || null
  };

  try {
    let error;
    if (id) {
      const res = await sb.from('partners').update(partnerData).eq('id', id);
      error = res.error;
    } else {
      const res = await sb.from('partners').insert([partnerData]);
      error = res.error;
    }

    if (error) throw error;

    showToast(id ? '更新成功' : '新增成功', 'success');
    closeModal('partner-modal');
    loadPartners();
  } catch (error) {
    console.error('Error saving partner:', error);
    showToast('儲存失敗：' + toErrorMessage(error), 'error');
  }
}

requireAuth(() => {
  setupResponsiveTable('#partners-table');
  loadPartners();

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentType = e.target.getAttribute('data-type');
      currentPage = 1;
      loadPartners();
    });
  });

  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadPartners();
    }
  });

  document.getElementById('btn-next-page').addEventListener('click', () => {
    if (currentPage < totalPages(totalCount)) {
      currentPage++;
      loadPartners();
    }
  });

  document.getElementById('btn-add-partner').addEventListener('click', () => {
    openEditModal();
  });

  bindSubmitOnce('btn-save-partner', savePartner);
});
