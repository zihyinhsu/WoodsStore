import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

// 這是多頁式應用（MPA）：每支 HTML 都是獨立進入點，
// 不列進 input 的頁面不會被打包，直接 404。新增頁面時記得補這裡。
const pages = ['index', 'login', 'products', 'orders', 'partners', 'payments', 'statement'];

export default defineConfig({
  // 相對路徑：產物可放在網域根目錄或子路徑，不必重新 build。
  base: './',
  build: {
    rollupOptions: {
      input: Object.fromEntries(
        pages.map(name => [name, resolve(projectRoot, `${name}.html`)])
      )
    }
  },
  // 綁 127.0.0.1（IPv4）而非預設的 localhost：Vite v7 + Node 17↑ 會把 localhost
  // 解析成 ::1，但這台開發機的 IPv6 loopback（::1）被資安過濾層攔截，TCP 握手會靜默
  // 卡住、瀏覽器整頁全白。綁 IPv4 可繞過；其他機器的 ::1 正常，綁死 IPv4 也不受影響。
  // preview 一併綁定：tests/helpers.js 的 BASE_URL 走 localhost:4173，否則本機跑測試同樣卡住。
  preview: { host: '127.0.0.1', port: 4173 },
  server: { host: '127.0.0.1', port: 5173 }
});
