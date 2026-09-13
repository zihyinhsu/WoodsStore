import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

// 這是多頁式應用（MPA）：每支 HTML 都是獨立進入點，
// 不列進 input 的頁面不會被打包，直接 404。新增頁面時記得補這裡。
const pages = ['index', 'products', 'orders', 'partners', 'payments', 'statement'];

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
  // preview 對齊測試預期的 4173（tests/helpers.js 的 BASE_URL 預設值）。
  preview: { port: 4173 },
  server: { port: 5173 }
});
