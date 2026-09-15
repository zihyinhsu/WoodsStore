// ============================================================
// 身分驗證 guard
//
// 真正的存取控制在後端 RLS（policy 限 authenticated）；這裡只是前端 UI 層攔截，
// 讓未登入者不會看到需授權的頁面。前端擋不等於安全，兩者要一起做。
// ============================================================
import { sb } from './supabase.js';
import { onReady } from './ui.js';

// Supabase 把登入後的 session 存在 localStorage，key 形如 sb-<project-ref>-auth-token。
// 進頁先同步檢查有沒有這個 key：完全沒有就立刻跳轉，頁面主流程不必啟動、也少一次閃現。
function hasStoredSession() {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) return true;
  }
  return false;
}

// 各頁進入點用這個取代 onReady：驗證通過才執行頁面初始化。
// 用 getClaims() 而非 getSession()：前者會實際驗證 JWT 簽章，後者只讀 localStorage
// 不重新驗證，官方明確建議「保護頁面」用 getClaims。token 過期且無法續期即視為未登入。
export function requireAuth(onAuthed) {
  if (!hasStoredSession()) {
    location.replace('login.html');
    return;
  }

  onReady(async () => {
    const { data, error } = await sb.auth.getClaims();
    if (error || !data?.claims) {
      location.replace('login.html');
      return;
    }
    onAuthed();
  });
}
