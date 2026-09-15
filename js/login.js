// ============================================================
// 登入頁邏輯
// ============================================================
import { sb } from './supabase.js';
import { showToast, toErrorMessage, bindSubmitOnce } from './ui.js';

// 已登入者直接進系統，不用再看登入畫面。
sb.auth.getClaims().then(({ data }) => {
  if (data?.claims) location.replace('index.html');
});

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

  location.replace('index.html');
});

// Enter 送出：沿用 bindSubmitOnce 綁在按鈕上的防連點邏輯，直接觸發按鈕點擊。
['login-email', 'login-password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', event => {
    if (event.key === 'Enter') document.getElementById('btn-login').click();
  });
});
