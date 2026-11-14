// 退貨：從已確認的出貨單／進貨單建立銷貨退回／進貨退出。
//
// 從 orders.js 拆出來是因為那支已逾千行；退貨 modal 自成一套狀態（原單、每列可退數量、折讓稅額預帶），
// 與新增／編輯單據的 modal 互不相干。畫面骨架在 orders.html 的 #return-modal，這裡只負責填值與送出。
//
// 退貨單的正負號、庫存方向、成本快照全部由 DB 的 create_return_order 處理：
// 這裡送的 qty 一律是正數，不要在前端幫忙變號。
import { sb } from './supabase.js';
import { showToast, openModal, closeModal, toErrorMessage, bindSubmitOnce } from './ui.js';
import { formatCurrency, formatDate, toDateInputValue, escapeHtml, round2, sum, clamp, negativeClass } from './utils.js';

const TITLES = { sale: '銷貨退回', purchase: '進貨退出' };
const HINTS = {
  sale: '退貨金額以負數記入客戶應收，收款時勾選這張退貨單即可抵扣。',
  purchase: '退貨金額以負數記入應付供應商，付款時勾選這張退貨單即可抵扣。'
};

let current = null;
let onCreated = () => {};

const el = (id) => document.getElementById(id);

// 只有已確認的進貨／出貨單能退：草稿尚未生效、作廢單沒有庫存可退、調整單與退貨單本身不能再退。
export function canReturn(order) {
  return order.status === 'confirmed' && (order.type === 'sale' || order.type === 'purchase');
}

// 讀取每一列目前的輸入，數量與單價夾在合法範圍內，並同時回報輸入是否超出範圍。
// 前端先夾住範圍只是讓使用者不必等 DB 退件；真正的上限仍以 create_return_order 為準。
// 不能用 parseInt／parseFloat(...) || 0：數量打 2.5 會被默默截成 2、單價清空會變成 0 元退貨，
// 兩者都等於輸入值，不會被標成 rt-invalid，使用者看到的和實際送出的就對不上。
function readLines() {
  return [...el('return-lines').querySelectorAll('tbody tr')].map((tr, index) => {
    const { item, returnable } = current.lines[index];
    const maxPrice = Number(item.unit_price);
    const rawQty = Number(tr.querySelector('.rt-qty').value) || 0;
    const priceText = tr.querySelector('.rt-price').value.trim();
    const rawPrice = priceText === '' ? NaN : Number(priceText);
    const qty = clamp(Math.trunc(rawQty), 0, returnable);
    // 單價清空時改回原單單價，而不是 0：0 元退貨是少數情況，應該由使用者明確輸入 0。
    const price = Number.isFinite(rawPrice) ? round2(clamp(rawPrice, 0, maxPrice)) : maxPrice;
    // 明細折扣 % 沿用原單、不可改（DB 同樣不接受），所以這裡直接讀原單那一列。
    const factor = 1 - (Number(item.discount) || 0) / 100;

    return {
      tr, item, qty, price,
      qtyInvalid: rawQty !== qty,
      priceInvalid: !Number.isFinite(rawPrice) || round2(rawPrice) !== price,
      subtotal: round2(qty * price * factor),
      // 以原價計的金額：預帶折讓／稅額的比例用它，原因見 prefillAmounts
      atOriginalPrice: qty * maxPrice * factor
    };
  });
}

// 整單折讓與稅額依「退回的商品佔原單明細的比例」預帶，使用者可手改。
// 比例用原價算而不是用退貨單價：折讓與稅是原單對這批貨收的，單價被往下議價只是少退錢，
// 不代表折讓或稅也該跟著縮。
// 這次若把剩下的可退數量全部退完，就直接帶「原單剩餘額度」，不然多次退貨各自四捨五入，
// 最後一張會差幾分錢，永遠湊不滿原單的折讓／稅額。
function prefillAmounts(lines) {
  const { order, baseSubtotal, remaining } = current;
  const ratio = baseSubtotal > 0 ? round2(sum(lines, 'atOriginalPrice')) / baseSubtotal : 0;
  const finalReturn = lines.every((l, i) => l.qty === current.lines[i].returnable);

  const pick = (original, left) => finalReturn
    ? left
    : Math.min(round2(Number(original) * ratio), left);

  return {
    discount: pick(order.discount, remaining.discount),
    tax: pick(order.tax, remaining.tax)
  };
}

function render() {
  const lines = readLines();

  lines.forEach(l => {
    l.tr.querySelector('.rt-subtotal').textContent = formatCurrency(l.subtotal);
    l.tr.querySelector('.rt-qty').classList.toggle('rt-invalid', l.qtyInvalid);
    l.tr.querySelector('.rt-price').classList.toggle('rt-invalid', l.priceInvalid);
  });

  // 手改過的折讓／稅額就不再被自動預帶蓋掉，否則使用者改完一改數量又被洗掉。
  const prefill = prefillAmounts(lines);
  if (!current.touched.discount) el('return-discount').value = prefill.discount;
  if (!current.touched.tax) el('return-tax').value = prefill.tax;

  const discount = round2(el('return-discount').value);
  const tax = round2(el('return-tax').value);
  const total = round2(sum(lines, 'subtotal') - discount + tax);

  const totalEl = el('return-total');
  totalEl.textContent = formatCurrency(total);
  totalEl.className = `total-display ${negativeClass(total)}`;
}

// 輸入中不夾值（打「15」會先經過「1」），離開欄位時才把超出範圍的值改回合法值。
function clampInputs() {
  readLines().forEach(l => {
    if (l.qtyInvalid) l.tr.querySelector('.rt-qty').value = l.qty;
    if (l.priceInvalid) l.tr.querySelector('.rt-price').value = l.price;
  });
  render();
}

function renderLineRows(lines) {
  return lines.map(({ item, original, returned, returnable }) => {
    const p = item.products || {};
    const discountNote = Number(item.discount) > 0
      ? `<span class="text-muted" style="font-size: 0.8rem; display: block;">明細折扣 ${escapeHtml(item.discount)}%</span>`
      : '';
    return `
      <tr data-item-id="${escapeHtml(item.id)}">
        <td>${escapeHtml(p.name)} <span class="text-muted">(${escapeHtml(p.sku)})</span>${discountNote}</td>
        <td class="num rt-original">${original}</td>
        <td class="num rt-returned">${returned}</td>
        <td class="num rt-returnable">${returnable}</td>
        <td><input type="number" class="form-control rt-qty" min="0" max="${returnable}" step="1" value="0"
                   ${returnable === 0 ? 'disabled' : ''} aria-label="退貨數量"></td>
        <td><input type="number" class="form-control rt-price" min="0" max="${escapeHtml(item.unit_price)}" step="any"
                   value="${escapeHtml(item.unit_price)}" ${returnable === 0 ? 'disabled' : ''} aria-label="退貨單價"></td>
        <td class="num rt-subtotal">${formatCurrency(0)}</td>
      </tr>`;
  }).join('');
}

export async function openReturnModal(order) {
  if (!canReturn(order)) return;

  try {
    // 已退數量只算有效的退貨單（作廢的不算），與 create_return_order 的上限檢查同一個定義。
    // 折讓與稅額也要知道歷次退了多少：原單的額度是各張退貨單共用的（RETURN_AMOUNT_EXCEEDS）。
    const [itemsRes, returnedRes, returnOrdersRes] = await Promise.all([
      sb.from('order_items').select('*, products(name, sku, spec, unit)').eq('order_id', order.id),
      sb.from('order_items')
        .select('return_of_item_id, qty, orders!inner(status, return_of_order_id)')
        .eq('orders.return_of_order_id', order.id)
        .neq('orders.status', 'void'),
      // 直接查 orders：order_search_view 為了搜尋 join 了明細、往來對象與收付款彙總，只要兩個欄位不值得。
      sb.from('orders')
        .select('id, discount, tax')
        .eq('return_of_order_id', order.id)
        .neq('status', 'void')
    ]);
    if (itemsRes.error) throw itemsRes.error;
    if (returnedRes.error) throw returnedRes.error;
    if (returnOrdersRes.error) throw returnOrdersRes.error;

    const returnedQty = new Map();
    for (const row of returnedRes.data || []) {
      returnedQty.set(row.return_of_item_id, (returnedQty.get(row.return_of_item_id) || 0) + Math.abs(row.qty));
    }

    const lines = (itemsRes.data || []).map(item => {
      const original = Math.abs(item.qty);
      const returned = returnedQty.get(item.id) || 0;
      return { item, original, returned, returnable: Math.max(original - returned, 0) };
    });

    if (!lines.some(l => l.returnable > 0)) {
      showToast('此單據已全數退貨，沒有可退的數量', 'info');
      return;
    }

    const returnOrders = returnOrdersRes.data || [];
    current = {
      order,
      lines,
      baseSubtotal: round2(sum(lines.map(l => l.item), 'subtotal')),
      remaining: {
        discount: Math.max(round2(Number(order.discount) - sum(returnOrders, 'discount')), 0),
        tax: Math.max(round2(Number(order.tax) - sum(returnOrders, 'tax')), 0)
      },
      touched: { discount: false, tax: false }
    };

    const isSale = order.type === 'sale';
    el('return-modal-title').textContent = `${TITLES[order.type]} - ${order.order_no}`;
    el('return-info').innerHTML = `
      原單：<strong>${escapeHtml(order.order_no)}</strong>
      <span class="text-muted" style="margin: 0 0.5rem;">${formatDate(order.order_date)}</span>
      ${isSale ? '客戶' : '供應商'}：${escapeHtml(order.partner_name || '-')}`;
    el('return-hint').textContent = HINTS[order.type];

    // 退貨日不可早於原單日期（RETURN_DATE_INVALID）：否則作廢檢查與報表的時間序會錯亂。
    const orderDay = String(order.order_date).slice(0, 10);
    const dateInput = el('return-date');
    dateInput.min = orderDay;
    dateInput.value = toDateInputValue(new Date());
    el('return-note').value = '';
    el('return-discount').value = 0;
    el('return-tax').value = 0;
    el('return-lines').querySelector('tbody').innerHTML = renderLineRows(lines);

    render();
    openModal('return-modal');
  } catch (error) {
    console.error('Error loading order for return:', error);
    showToast('載入退貨資料失敗：' + toErrorMessage(error), 'error');
  }
}

async function submitReturn() {
  if (!current) return;
  const { order } = current;

  // 超出範圍的輸入先改回合法值再讓使用者確認：直接悄悄用夾過的值送出，
  // 使用者會以為自己輸入的數量被接受了。
  if (el('return-lines').querySelector('.rt-invalid')) {
    clampInputs();
    showToast('數量或單價超出範圍，已自動調整，請確認後再送出', 'error');
    return;
  }

  const lines = readLines().filter(l => l.qty > 0);
  if (lines.length === 0) {
    showToast('請至少輸入一項退貨數量', 'error');
    return;
  }

  const orderDate = el('return-date').value;
  if (!orderDate) {
    showToast('請選擇退貨日期', 'error');
    return;
  }
  if (orderDate < String(order.order_date).slice(0, 10)) {
    showToast(`退貨日期不可早於原單日期（${formatDate(order.order_date)}）`, 'error');
    return;
  }

  const discount = round2(el('return-discount').value);
  const tax = round2(el('return-tax').value);
  if (discount < 0 || tax < 0) {
    showToast('整單折讓與稅額不可為負數', 'error');
    return;
  }
  if (round2(sum(lines, 'subtotal') - discount + tax) < 0) {
    showToast('退貨金額不可為負數，請調低整單折讓', 'error');
    return;
  }

  try {
    const { error } = await sb.rpc('create_return_order', {
      p_original_order_id: order.id,
      p_items: lines.map(l => ({ item_id: l.item.id, qty: l.qty, unit_price: l.price })),
      p_order_date: orderDate,
      p_discount: discount,
      p_tax: tax,
      p_note: el('return-note').value || null
    });
    if (error) throw error;

    showToast('退貨單已建立', 'success');
    closeModal('return-modal');
    current = null;
    onCreated();
  } catch (error) {
    console.error('Error creating return order:', error);
    showToast('建立退貨單失敗：' + toErrorMessage(error), 'error');
  }
}

// 事件只綁一次；開 modal 時不重綁，否則每開一次就多一份監聽、送出會重複。
export function setupOrderReturn({ onCreated: callback }) {
  onCreated = callback;

  const lines = el('return-lines').querySelector('tbody');
  lines.addEventListener('input', () => current && render());
  lines.addEventListener('change', () => current && clampInputs());

  for (const kind of ['discount', 'tax']) {
    el(`return-${kind}`).addEventListener('input', () => {
      if (!current) return;
      current.touched[kind] = true;
      render();
    });
  }

  bindSubmitOnce('btn-save-return', submitReturn);
}
