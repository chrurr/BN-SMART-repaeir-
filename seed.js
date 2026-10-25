require("dotenv").config();
const bcrypt = require("bcryptjs");
const { init } = require("./src/db/init");
const { pool, one } = require("./src/db/pool");

(async () => {
  await init();
  const shop = await one("SELECT id FROM shops WHERE slug='bn-smart'");
  if (!shop) throw new Error("Default shop was not created by init()");
  const hash = await bcrypt.hash(process.env.DEFAULT_ADMIN_PASSWORD || "Admin@12345", 12);
  await pool.query(
    "UPDATE users SET password_hash=$1, active=true WHERE shop_id=$2 AND username='admin'",
    [hash, shop.id]
  );
  console.log("Admin reset: admin / " + (process.env.DEFAULT_ADMIN_PASSWORD || "Admin@12345"));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
