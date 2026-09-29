const fs = require('fs');
const { installRoot, readRuntime, request, removeStartup } = require('../installer');

async function main() {
  const runtime = readRuntime();
  if (runtime) {
    try { await request(runtime, 'POST', '/api/shutdown', {}); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  removeStartup();
  fs.rmSync(installRoot, { recursive: true, force: true });
  console.log('工作台助手已卸载');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
