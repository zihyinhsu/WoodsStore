// ============================================================
// Supabase client 單例
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// 變數沒設定時 createClient 會丟出難懂的錯誤，先給明確訊息。
// 環境變數在 build 時內嵌，缺值代表 .env 沒建立或 Vercel 沒設定後未重新部署。
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR-PROJECT')) {
  alert('尚未設定 Supabase 連線資訊：本機請建立 .env（可複製 .env.example），部署環境請設定 VITE_SUPABASE_URL 與 VITE_SUPABASE_ANON_KEY 後重新部署。');
}

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
