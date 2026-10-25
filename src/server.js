const { PORT } = require("./config");
const app = require("./app");
const { init } = require("./db/init");

init()
  .then(() => app.listen(PORT, () => console.log(`BN SMART running on http://localhost:${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });
