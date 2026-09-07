// ============================================================
// Supabase client 單例
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

if (SUPABASE_URL.includes('YOUR-PROJECT')) {
  alert('尚未設定 Supabase 連線資訊，請編輯 js/config.js');
}

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
