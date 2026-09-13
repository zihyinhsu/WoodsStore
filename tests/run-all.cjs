const { spawn } = require('child_process');
const path = require('path');

const SUITES = [
  'sorting.test.cjs',
  'statement.test.cjs',
  'orders-edit.test.cjs',
  'forms.test.cjs',
  'dashboard.test.cjs',
  'products-tabs.test.cjs'
];

const run = file => new Promise(resolve => {
  console.log(`\n${'='.repeat(60)}\n${file}\n${'='.repeat(60)}`);
  const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  child.on('close', code => resolve({ file, code }));
});

(async () => {
  const results = [];
  for (const suite of SUITES) {
    results.push(await run(suite));
  }

  console.log(`\n${'='.repeat(60)}\n總結\n${'='.repeat(60)}`);
  results.forEach(({ file, code }) => {
    console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${file}`);
  });

  const failed = results.filter(r => r.code !== 0);
  if (failed.length) {
    console.log(`\n${failed.length} / ${results.length} 個測試套件失敗`);
    process.exit(1);
  }
  console.log(`\n全部 ${results.length} 個測試套件通過`);
})();
