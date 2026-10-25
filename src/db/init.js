const fs=require("fs");
const path=require("path");
const bcrypt=require("bcryptjs");
const {pool}=require("./pool");
const {ROOT,DEFAULT_ADMIN_PASSWORD}=require("../config");
const {DEFAULT_PERMS}=require("../lib/constants");
async function init(){
  const schemaCandidates = [
    path.join(ROOT, "db", "schema.sql"),
    path.join(ROOT, "BN-SMART-schema.sql"),
    path.join(ROOT, "src", "db", "schema.sql"),
  ];
  const schemaPath = schemaCandidates.find((p) => fs.existsSync(p));
  if (!schemaPath) {
    throw new Error(`Database schema not found. Checked: ${schemaCandidates.join(", ")}`);
  }
  const schema=fs.readFileSync(schemaPath,"utf8");
  await pool.query(schema);

  // SaaS foundation: create the tenant table and migrate legacy single-shop data
  // into one default tenant before enabling RLS.
  await pool.query(`CREATE TABLE IF NOT EXISTS shops (
    id BIGSERIAL PRIMARY KEY, slug VARCHAR(80) UNIQUE NOT NULL, name VARCHAR(160) NOT NULL,
    logo TEXT, phone VARCHAR(40), address TEXT, currency VARCHAR(12) NOT NULL DEFAULT 'DZD',
    receipt_settings JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  const defaultShop=(await pool.query("SELECT * FROM shops WHERE slug='bn-smart' LIMIT 1")).rows[0] ||
    (await pool.query("INSERT INTO shops(slug,name,phone,address,currency) VALUES('bn-smart','BN SMART','0668069475','غرداية- كارفور مرغوب- بجانب الجزار','DZD') RETURNING *")).rows[0];
  await pool.query(`ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS customer_received BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE repair_parts ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2) NOT NULL DEFAULT 0`);

  // Compatibility migration: older deployments may have been created from a schema
  // that did not contain supplier_purchases. Create the table before any ALTER/INDEX/FK
  // statements so startup is self-healing instead of failing with 42P01.
  await pool.query(`CREATE TABLE IF NOT EXISTS supplier_purchases (
    id BIGSERIAL PRIMARY KEY,
    shop_id BIGINT,
    supplier VARCHAR(120) NOT NULL,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_by BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const tenantTables=['users','customers','repair_orders','repair_status_history','payments','spare_parts','repair_parts','inventory_transactions','notifications','activity_logs'];
  for(const table of tenantTables){
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS shop_id BIGINT`);
    await pool.query(`UPDATE ${table} SET shop_id=$1 WHERE shop_id IS NULL`,[defaultShop.id]);
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN shop_id SET NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_shop_id ON ${table}(shop_id)`);
  }
  await pool.query(`ALTER TABLE supplier_purchases ADD COLUMN IF NOT EXISTS shop_id BIGINT`);
  await pool.query(`UPDATE supplier_purchases SET shop_id=$1 WHERE shop_id IS NULL`,[defaultShop.id]);
  await pool.query(`ALTER TABLE supplier_purchases ALTER COLUMN shop_id SET NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_supplier_purchases_shop_id ON supplier_purchases(shop_id)`);
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_shop_username ON users(shop_id,username)`);
  const fkTables=['users',...tenantTables.filter(t=>t!=='users'),'supplier_purchases'];
  for(const table of fkTables){
    const cname=`fk_${table}_shop`;
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${cname}') THEN ALTER TABLE ${table} ADD CONSTRAINT ${cname} FOREIGN KEY(shop_id) REFERENCES shops(id) ON DELETE CASCADE; END IF; END $$;`);
  }

  // Merge duplicate customers by (shop, phone) and prevent new duplicates.
  // Empty phones are never treated as the same customer.
  await pool.query(`WITH d AS (
    SELECT shop_id, phone, MIN(id) AS keep_id FROM customers
    WHERE phone <> '' GROUP BY shop_id, phone HAVING COUNT(*) > 1
  )
  UPDATE repair_orders r SET customer_id=d.keep_id
  FROM customers c JOIN d ON c.shop_id=d.shop_id AND c.phone=d.phone
  WHERE r.customer_id=c.id AND c.id<>d.keep_id`);
  await pool.query(`WITH d AS (
    SELECT shop_id, phone, MIN(id) AS keep_id FROM customers
    WHERE phone <> '' GROUP BY shop_id, phone HAVING COUNT(*) > 1
  )
  DELETE FROM customers c USING d
  WHERE c.shop_id=d.shop_id AND c.phone=d.phone AND c.id<>d.keep_id`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_shop_phone ON customers(shop_id, phone) WHERE phone <> ''`);

  // Settings used to be global. Migrate it once to tenant-scoped key/value storage.
  const settingsHasShop=await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='settings' AND column_name='shop_id'`);
  if(!settingsHasShop.rows.length){
    await pool.query(`CREATE TABLE IF NOT EXISTS settings_tenant (id BIGSERIAL PRIMARY KEY, shop_id BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE, key VARCHAR(100) NOT NULL, value JSONB NOT NULL, UNIQUE(shop_id,key))`);
    const oldSettings=await pool.query("SELECT key,value FROM settings");
    for(const row of oldSettings.rows){ await pool.query("INSERT INTO settings_tenant(shop_id,key,value) VALUES($1,$2,$3) ON CONFLICT(shop_id,key) DO UPDATE SET value=EXCLUDED.value",[defaultShop.id,row.key,row.value]); }
    await pool.query("DROP TABLE settings");
    await pool.query("ALTER TABLE settings_tenant RENAME TO settings");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_settings_shop_id ON settings(shop_id)");
  }

  const exists=(await pool.query("SELECT id FROM users WHERE shop_id=$1 LIMIT 1",[defaultShop.id])).rows[0];
  if(!exists){
    const hash=await bcrypt.hash(DEFAULT_ADMIN_PASSWORD,12);
    await pool.query("INSERT INTO users(shop_id,username,full_name,password_hash,role,permissions) VALUES($1,$2,$3,$4,'manager',$5)",
      [defaultShop.id,"admin","المدير الرئيسي",hash,JSON.stringify(Object.fromEntries(Object.keys(DEFAULT_PERMS).map(k=>[k,true]))) ]);
  }
  const shopRow=await pool.query("SELECT value FROM settings WHERE shop_id=$1 AND key='shop'",[defaultShop.id]);
  const shopValue=shopRow.rows[0]?.value && typeof shopRow.rows[0].value==='object' ? shopRow.rows[0].value : {};
  const fixedShop={...shopValue,name:"BN SMART"};
  await pool.query("INSERT INTO settings(shop_id,key,value) VALUES($1,'shop',$2) ON CONFLICT(shop_id,key) DO UPDATE SET value=EXCLUDED.value",[defaultShop.id,JSON.stringify(fixedShop)]);

  // Enforce tenant isolation in PostgreSQL for every tenant-owned table.
  const rlsTables=['users','customers','repair_orders','repair_status_history','payments','spare_parts','repair_parts','inventory_transactions','notifications','activity_logs','supplier_purchases','settings'];
  for(const table of rlsTables){
    await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table}`);
    await pool.query(`CREATE POLICY ${table}_tenant_isolation ON ${table} USING (shop_id = NULLIF(current_setting('app.shop_id', true),'')::bigint) WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true),'')::bigint)`);
  }

  // Public tracking uses a narrowly-scoped SECURITY DEFINER function. It accepts
  // only a tracking code and returns one repair, while authenticated APIs remain RLS-protected.
  await pool.query(`CREATE OR REPLACE FUNCTION public_track_repair(p_code TEXT) RETURNS TABLE(
    id BIGINT, receipt_no INTEGER, tracking_code VARCHAR, brand VARCHAR, model VARCHAR, color VARCHAR, fault TEXT, status VARCHAR,
    updated_at TIMESTAMPTZ, due_at TIMESTAMPTZ, expected_price NUMERIC, paid_amount NUMERIC, accessories JSONB, customer_name VARCHAR, customer_phone VARCHAR
  ) LANGUAGE SQL SECURITY DEFINER SET search_path=public AS $$
    SELECT r.id,r.receipt_no,r.tracking_code,r.brand,r.model,r.color,r.fault,r.status,r.updated_at,r.due_at,r.expected_price,r.paid_amount,r.accessories,c.name,c.phone
    FROM repair_orders r JOIN customers c ON c.id=r.customer_id WHERE r.tracking_code=p_code LIMIT 1;
  $$`);
  await pool.query(`REVOKE ALL ON FUNCTION public_track_repair(TEXT) FROM PUBLIC`);
  await pool.query(`GRANT EXECUTE ON FUNCTION public_track_repair(TEXT) TO PUBLIC`);
  await pool.query(`CREATE OR REPLACE FUNCTION public_track_history(p_repair_id BIGINT) RETURNS JSON LANGUAGE SQL SECURITY DEFINER SET search_path=public AS $$
    SELECT COALESCE(json_agg(x ORDER BY x.created_at),'[]'::json) FROM (SELECT status,created_at FROM repair_status_history WHERE repair_id=p_repair_id) x;
  $$`);
  await pool.query(`REVOKE ALL ON FUNCTION public_track_history(BIGINT) FROM PUBLIC`);
  await pool.query(`GRANT EXECUTE ON FUNCTION public_track_history(BIGINT) TO PUBLIC`);
}
module.exports={init};
