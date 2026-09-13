// ============================================================
// Supabase 連線設定
// 值來自環境變數，不寫死在程式碼裡：
//   本機   → 專案根目錄的 .env（複製 .env.example 後填入）
//   Vercel → Project Settings → Environment Variables
//
// ⚠️ VITE_ 開頭的變數會在 build 時內嵌進產物，瀏覽器可見。
//    只放 publishable (anon) key，存取控制靠 RLS。
// ============================================================
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
