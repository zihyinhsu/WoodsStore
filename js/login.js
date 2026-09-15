// ============================================================
// 登入頁邏輯
// ============================================================
import { sb } from './supabase.js';
import { showToast, toErrorMessage, bindSubmitOnce } from './ui.js';

const REMEMBER_KEY = 'login-remember';

// 已登入者直接進系統，不用再看登入畫面。
sb.auth.getClaims().then(({ data }) => {
  if (data?.claims) location.replace('index.html');
});

// 還原上次記住的帳號，未登入時自動填好、省得每次重打。
// 只記帳號不記密碼：密碼存進 localStorage 會被同源 JS／XSS 讀到，帳號則風險低。
const rememberedEmail = localStorage.getItem(REMEMBER_KEY);
if (rememberedEmail) {
  document.getElementById('login-email').value = rememberedEmail;
  document.getElementById('remember-me').checked = true;
}

bindSubmitOnce('btn-login', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  if (!email || !password) {
    showToast('請輸入帳號與密碼', 'error');
    return;
  }

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    // 帳密不符 Supabase 回 "Invalid login credentials"，toErrorMessage 沒對應，
    // 給使用者看得懂的訊息；其餘（網路等）交回 toErrorMessage 統一處理。
    const message = /invalid login credentials/i.test(error.message)
      ? '帳號或密碼錯誤'
      : toErrorMessage(error);
    showToast(message, 'error');
    return;
  }

  // 勾選才記住帳號，取消勾選就清掉先前記住的帳號
  if (document.getElementById('remember-me').checked) {
    localStorage.setItem(REMEMBER_KEY, email);
  } else {
    localStorage.removeItem(REMEMBER_KEY);
  }

  location.replace('index.html');
});

// Enter 送出：沿用 bindSubmitOnce 綁在按鈕上的防連點邏輯，直接觸發按鈕點擊。
['login-email', 'login-password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', event => {
    if (event.key === 'Enter') document.getElementById('btn-login').click();
  });
});
