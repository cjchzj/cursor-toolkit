const path = require('path');
const { ensureCompanion } = require('../installer');
const pkg = require('../package.json');

ensureCompanion(path.resolve(__dirname, '..'), pkg.version, console.log)
  .then((runtime) => {
    console.log(`工作台已安装并运行：http://127.0.0.1:${runtime.port}`);
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
