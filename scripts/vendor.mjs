// 把 supabase-js 打包成瀏覽器可直接 import 的自足 ESM 檔。
//
// 不能直接複製 dist/index.mjs：它帶有 @supabase/auth-js 這類 bare import，
// 瀏覽器沒有 import map 就解析不了。這支腳本由 postinstall 觸發，
// 產物 js/vendor/ 不進版控，開發時不需要重跑。

import { build } from 'esbuild';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(projectRoot, 'js/vendor/supabase-js.mjs');

const { version } = JSON.parse(
  await readFile(resolve(projectRoot, 'node_modules/@supabase/supabase-js/package.json'), 'utf8')
);

await mkdir(dirname(outFile), { recursive: true });

await build({
  entryPoints: [resolve(projectRoot, 'node_modules/@supabase/supabase-js/dist/index.mjs')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  banner: { js: `// @supabase/supabase-js v${version} — 由 npm run vendor 產生，請勿手動編輯。` },
  // React Native / Node 專用的選用相依，瀏覽器環境用不到，
  // 留著會讓 esbuild 因解析不到而中斷。
  external: ['@react-native-async-storage/async-storage', 'expo-secure-store']
});

const { size } = await stat(outFile);

console.log(`vendor: supabase-js v${version} -> js/vendor/supabase-js.mjs (${Math.round(size / 1024)} KB)`);
