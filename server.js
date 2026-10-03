require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const { AsyncLocalStorage } = require("async_hooks");
const tenantContext = new AsyncLocalStorage();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));
app.use("/api", (req,res,next)=>{ res.set("Cache-Control","no-store"); next(); });
app.use((req,res,next)=>{ res.set("X-Content-Type-Options","nosniff"); res.set("Referrer-Policy","strict-origin-when-cross-origin"); next(); });

const pool = new Pool({connectionString: process.env.DATABASE_URL});

// Every authenticated request carries its tenant in AsyncLocalStorage.
// The query wrapper sets PostgreSQL session context on the same connection,
// allowing Row-Level Security to enforce tenant isolation server-side.
const rawPoolQuery = pool.query.bind(pool);
pool.query = async function tenantAwareQuery(text, params) {
  const ctx = tenantContext.getStore();
  if (!ctx?.shopId) return rawPoolQuery(text, params);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.shop_id',$1,true)",[String(ctx.shopId)]);
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally { client.release(); }
};

async function setTenant(client, shopId){
  await client.query("SELECT set_config('app.shop_id',$1,true)",[String(shopId)]);
}
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "Admin@12345";

const DEFAULT_PERMS = {
  add_repair:true, view_repairs:true, edit_repair:true, change_status:true,
  customers:true, edit_customers:true, inventory:true, accounts:false,
  profits:false, reports:false, delete_repairs:false, delete_customers:false,
  users:false, settings:false, activity_logs:false, backups:false
};
const STATUSES = ["قيد الاصلاح","تم اصلاحه","لايصلح"];

async function q(text, params=[]){ return (await pool.query(text,params)).rows; }
async function one(text, params=[]){ return (await pool.query(text,params)).rows[0]; }
async function init(){
  const schema=fs.readFileSync(path.join(__dirname,"db","schema.sql"),"utf8");
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
function auth(req,res,next){
  const h=req.headers.authorization||"";
  const token=h.startsWith("Bearer ")?h.slice(7):null;
  if(!token)return res.status(401).json({error:"تسجيل الدخول مطلوب"});
  try{
    req.user=jwt.verify(token,JWT_SECRET);
    if(!req.user.shop_id)return res.status(401).json({error:"الجلسة لا تحتوي على محل صالح"});
    tenantContext.run({shopId:req.user.shop_id},()=>next());
  }catch(e){res.status(401).json({error:"الجلسة غير صالحة"})}
}
function manager(req,res,next){ if(req.user.role!=="manager")return res.status(403).json({error:"هذه العملية للمدير فقط"}); next(); }
function can(permission){return (req,res,next)=>{ if(req.user.role==="manager" || req.user.permissions?.[permission]) return next(); res.status(403).json({error:"لا تملك هذه الصلاحية"}); }}
async function log(userId,action,repairId=null,details={}){const ctx=tenantContext.getStore();await pool.query("INSERT INTO activity_logs(shop_id,user_id,action,repair_id,details) VALUES($1,$2,$3,$4,$5)",[ctx?.shopId||null,userId,action,repairId,JSON.stringify(details)])}

app.post("/api/auth/register-shop",async(req,res)=>{
  const b=req.body||{};
  const shopName=String(b.shopName||"").trim();
  const slug=String(b.slug||shopName).trim().toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60);
  const username=String(b.username||"admin").trim();
  const password=String(b.password||"");
  if(shopName.length<2 || !slug || username.length<2 || password.length<8) return res.status(400).json({error:"اسم المحل، اسم المستخدم وكلمة مرور من 8 أحرف على الأقل مطلوبة"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const shop=(await client.query("INSERT INTO shops(slug,name,phone,address,currency) VALUES($1,$2,$3,$4,$5) RETURNING *",[slug,shopName,String(b.phone||""),String(b.address||""),String(b.currency||"DZD")])).rows[0];
    await setTenant(client,shop.id);
    const hash=await bcrypt.hash(password,12);
    const permissions=Object.fromEntries(Object.keys(DEFAULT_PERMS).map(k=>[k,true]));
    const user=(await client.query("INSERT INTO users(shop_id,username,full_name,phone,password_hash,role,permissions) VALUES($1,$2,$3,$4,$5,'manager',$6) RETURNING id,username,full_name,role,shop_id",[shop.id,username,String(b.fullName||shopName),String(b.phone||""),hash,JSON.stringify(permissions)])).rows[0];
    await client.query("INSERT INTO settings(shop_id,key,value) VALUES($1,'shop',$2)",[shop.id,JSON.stringify({name:shopName,phone:b.phone||"",address:b.address||"",currency:b.currency||"DZD"})]);
    await client.query("COMMIT");
    res.status(201).json({shop:{id:shop.id,slug:shop.slug,name:shop.name},user});
  }catch(e){try{await client.query("ROLLBACK")}catch{}; if(e?.code==='23505') return res.status(409).json({error:"اسم المحل أو اسم المستخدم مستخدم بالفعل"}); console.error(e);res.status(500).json({error:"تعذر إنشاء المحل"});}finally{client.release()}
});

app.post("/api/auth/login",async(req,res)=>{
  try{
    const {username,password,shopSlug}=req.body;
    const slug=String(shopSlug||"bn-smart").trim().toLowerCase();
    const shop=await one("SELECT id,slug,name,active FROM shops WHERE slug=$1",[slug]);
    if(!shop || !shop.active) return res.status(401).json({error:"المحل غير موجود أو غير مفعل"});
    const u=(await pool.query("SELECT * FROM users WHERE shop_id=$1 AND username=$2",[shop.id,username])).rows[0];
    if(!u || !u.active || !(await bcrypt.compare(password||"",u.password_hash))) return res.status(401).json({error:"اسم المستخدم أو كلمة المرور غير صحيحة"});
    await tenantContext.run({shopId:shop.id},()=>pool.query("UPDATE users SET last_login=NOW() WHERE id=$1",[u.id]));
    const permissions=u.role==="manager"?Object.fromEntries(Object.keys(DEFAULT_PERMS).map(k=>[k,true])):{...DEFAULT_PERMS,...u.permissions};
    const token=jwt.sign({id:u.id,username:u.username,full_name:u.full_name,role:u.role,permissions,shop_id:shop.id,shop_slug:shop.slug},JWT_SECRET,{expiresIn:"30d"});
    res.json({token,user:{id:u.id,username:u.username,full_name:u.full_name,role:u.role,permissions,shop_id:shop.id,shop_slug:shop.slug,shop_name:shop.name}});
  }catch(e){res.status(500).json({error:"خطأ في الخادم"})}
});
app.get("/api/auth/me",auth,(req,res)=>res.json({user:req.user}));
app.get("/health",(req,res)=>res.json({ok:true,service:"BN SMART"}));

app.get("/api/dashboard",auth,can("view_repairs"),async(req,res)=>{
  const stats=await one(`SELECT
    COUNT(*) FILTER(WHERE status='قيد الاصلاح') AS in_repair,
    COUNT(*) FILTER(WHERE status='تم اصلاحه') AS repaired,
    COUNT(*) FILTER(WHERE status='لايصلح') AS not_repairable,
    COUNT(*) FILTER(WHERE created_at::date=CURRENT_DATE) AS received_today,
    COUNT(*) FILTER(WHERE customer_received=TRUE) AS customer_received_count,
    COALESCE(SUM(paid_amount),0) AS revenue,
    COALESCE(SUM(expected_price-part_cost) FILTER(WHERE customer_received=TRUE),0) AS profit,
    COALESCE(SUM(expected_price-paid_amount),0) AS remaining
    FROM repair_orders`);
  const recent=await q(`SELECT r.*,c.name customer_name,c.phone FROM repair_orders r JOIN customers c ON c.id=r.customer_id ORDER BY r.created_at DESC LIMIT 8`);
  const statuses=await q("SELECT status,COUNT(*) count FROM repair_orders GROUP BY status");
  res.json({stats,recent,statuses});
});

app.get("/api/reports/daily",auth,can("reports"),async(req,res)=>{
  try{
    const period=String(req.query.period||"30");
    let where="";
    const params=[];
    if(period!=="all"){
      const days=Math.max(1,Math.min(3650,Number(period)||30));
      params.push(days);
      where=`WHERE r.created_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'`;
    }
    const rows=await q(`SELECT r.created_at::date AS day, COUNT(*)::int AS repairs_count,
      COALESCE(SUM(r.paid_amount),0)::numeric AS paid,
      COALESCE(SUM(r.expected_price-r.part_cost) FILTER (WHERE r.customer_received=TRUE),0)::numeric AS profit
      FROM repair_orders r ${where}
      GROUP BY r.created_at::date ORDER BY repairs_count DESC, day DESC`,params);
    const total=rows.reduce((n,r)=>n+Number(r.repairs_count||0),0);
    const totalPaid=rows.reduce((n,r)=>n+Number(r.paid||0),0);
    const totalProfit=rows.reduce((n,r)=>n+Number(r.profit||0),0);
    const daysSpan=period==="all"?Math.max(rows.length,1):Math.max(1,Number(period)||30);
    res.json({
      total_repairs: total,
      total_paid: totalPaid,
      total_profit: totalProfit,
      average_daily_repairs: total/daysSpan,
      days: rows.map(r=>({...r,percent: total?Number(r.repairs_count)*100/total:0}))
    });
  }catch(e){console.error(e);res.status(500).json({error:"تعذر تحميل تقرير الأيام"})}
});

app.get("/api/repairs",auth,can("view_repairs"),async(req,res)=>{
  const {search="",status=""}=req.query;
  const params=[];let where=[];
  if(status){params.push(status);where.push(`r.status=$${params.length}`)}
  if(search){params.push(`%${search}%`);where.push(`(r.receipt_no::text ILIKE $${params.length} OR r.tracking_code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR r.brand ILIKE $${params.length} OR r.model ILIKE $${params.length})`)}
  const sql=`SELECT r.*,c.name customer_name,c.phone customer_phone,u.full_name created_by_name
             FROM repair_orders r JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.created_by
             ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY r.created_at DESC`;
  res.json(await q(sql,params));
});
app.get("/api/repairs/:id",auth,can("view_repairs"),async(req,res)=>{
  const r=await one(`SELECT r.*,c.name customer_name,c.phone customer_phone,c.id customer_id,
    cu.full_name created_by_name,uu.full_name updated_by_name
    FROM repair_orders r JOIN customers c ON c.id=r.customer_id
    LEFT JOIN users cu ON cu.id=r.created_by LEFT JOIN users uu ON uu.id=r.updated_by WHERE r.id=$1`,[req.params.id]);
  if(!r)return res.status(404).json({error:"الإصلاح غير موجود"});
  r.history=await q(`SELECT h.*,u.full_name changed_by_name FROM repair_status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE repair_id=$1 ORDER BY h.created_at`,[req.params.id]);
  r.payments=await q(`SELECT p.*,u.full_name recorded_by_name FROM payments p LEFT JOIN users u ON u.id=p.recorded_by WHERE repair_id=$1 ORDER BY p.created_at DESC`,[req.params.id]);
  r.parts=await q(`SELECT rp.*,sp.name part_name FROM repair_parts rp JOIN spare_parts sp ON sp.id=rp.part_id WHERE rp.repair_id=$1`,[req.params.id]);
  res.json(r);
});

app.post("/api/repairs",auth,can("add_repair"),async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await setTenant(client,req.user.shop_id);
    const b=req.body;
    const customerName=String(b.customerName||"عميل").trim()||"عميل";
    const phone=String(b.phone||"").trim();
    let customerId;
    // Never rename an existing customer when creating a new repair.
    // Empty phone numbers never match another customer.
    if(phone){
      const c=await client.query("SELECT id FROM customers WHERE phone=$1 ORDER BY id LIMIT 1",[phone]);
      if(c.rows[0]) customerId=c.rows[0].id;
      else customerId=(await client.query("INSERT INTO customers(shop_id,name,phone) VALUES($1,$2,$3) RETURNING id",[req.user.shop_id,customerName,phone])).rows[0].id;
    }else{
      customerId=(await client.query("INSERT INTO customers(shop_id,name,phone) VALUES($1,$2,$3) RETURNING id",[req.user.shop_id,customerName,""])).rows[0].id;
    }
    await client.query("SELECT pg_advisory_xact_lock(1842026)");
    const last=await client.query("SELECT COALESCE(MAX(receipt_no),184)+1 n FROM repair_orders");
    const no=last.rows[0].n, tracking="QF-"+String(no).padStart(4,"0");
    const r=(await client.query(`INSERT INTO repair_orders(shop_id,receipt_no,tracking_code,customer_id,brand,model,color,power_state,fault,diagnosis,expected_price,paid_amount,part_cost,labor_fee,status,accessories,accessory_notes,notes,supplier,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,'قيد الاصلاح',$15,$16,$17,$18,$19,$19) RETURNING *`,
      [req.user.shop_id,no,tracking,customerId,b.brand,b.model,b.color,b.power,b.fault,b.diagnosis,Number(b.price)||0,Number(b.paid)||0,Number(b.partCost)||0,Math.max(0,(Number(b.price)||0)-(Number(b.partCost)||0)),JSON.stringify(b.accessories||[]),b.accessoryNotes||"",b.notes||"",b.supplier||"",req.user.id])).rows[0];
    await client.query("INSERT INTO repair_status_history(shop_id,repair_id,status,changed_by) VALUES($1,$2,$3,$4)",[req.user.shop_id,r.id,r.status,req.user.id]);
    await client.query("COMMIT");
    await log(req.user.id,"إضافة وصل",r.id,{receipt_no:no});
    res.status(201).json(r);
  }catch(e){await client.query("ROLLBACK");console.error(e);res.status(500).json({error:"تعذر إنشاء الوصل"})}finally{client.release()}
});

app.patch("/api/repairs/:id",auth,can("edit_repair"),async(req,res)=>{
  const b=req.body;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await setTenant(client,req.user.shop_id);
    const existing=await client.query("SELECT * FROM repair_orders WHERE id=$1 FOR UPDATE",[req.params.id]);
    if(!existing.rows[0]){await client.query("ROLLBACK");return res.status(404).json({error:"غير موجود"})}
    const old=existing.rows[0];
    let customerId=old.customer_id;
    if(b.customerName!==undefined || b.phone!==undefined){
      const oldCustomer=(await client.query("SELECT id,name,phone FROM customers WHERE id=$1",[old.customer_id])).rows[0];
      const newName=String(b.customerName===undefined?(oldCustomer?.name||"عميل"):b.customerName).trim()||"عميل";
      const newPhone=String(b.phone===undefined?(oldCustomer?.phone||""):b.phone).trim();
      const oldName=String(oldCustomer?.name||"").trim();
      const oldPhone=String(oldCustomer?.phone||"").trim();
      if(newName!==oldName || newPhone!==oldPhone){
        // Never mutate a shared customer record when editing one repair.
        const same=await client.query("SELECT id FROM customers WHERE name=$1 AND phone=$2 ORDER BY id LIMIT 1",[newName,newPhone]);
        if(same.rows[0]) customerId=same.rows[0].id;
        else customerId=(await client.query("INSERT INTO customers(shop_id,name,phone) VALUES($1,$2,$3) RETURNING id",[req.user.shop_id,newName,newPhone])).rows[0].id;
      }
    }
    const r=(await client.query(`UPDATE repair_orders SET
      customer_id=$1, brand=$2, model=$3, color=$4, due_at=COALESCE($5,due_at),
      power_state=$7, fault=$8, diagnosis=$9, expected_price=COALESCE($10,expected_price), paid_amount=COALESCE($11,paid_amount),
      part_cost=COALESCE($12,part_cost), accessories=COALESCE($13,accessories), accessory_notes=COALESCE($14,accessory_notes),
      notes=COALESCE($15,notes), supplier=COALESCE($16,supplier), updated_by=$17,updated_at=NOW() WHERE id=$18 RETURNING *`,
      [customerId,b.brand,b.model,b.color,b.dueAt===undefined?null:b.dueAt,b.power,b.fault,b.diagnosis,
       b.price===undefined?null:Number(b.price),b.paid===undefined?null:Number(b.paid),b.partCost===undefined?null:Number(b.partCost),
       b.accessories==null?null:JSON.stringify(b.accessories),b.accessoryNotes,b.notes,b.supplier,req.user.id,req.params.id])).rows[0];
    await client.query("COMMIT");
    await log(req.user.id,"تعديل بيانات الوصل",r.id,{changed_fields:Object.keys(b)});
    res.json(r);
  }catch(e){await client.query("ROLLBACK");console.error(e);res.status(500).json({error:"تعذر تعديل الوصل"})}finally{client.release()}
});

app.get("/api/repairs/:id/parts",auth,can("view_repairs"),async(req,res)=>{
  res.json(await q(`SELECT rp.*,sp.name part_name FROM repair_parts rp JOIN spare_parts sp ON sp.id=rp.part_id WHERE rp.repair_id=$1 ORDER BY rp.created_at DESC`,[req.params.id]));
});
app.post("/api/repairs/:id/parts",auth,can("edit_repair"),async(req,res)=>{
  const name=String(req.body?.name||'').trim(); const qty=Math.max(1,Number(req.body?.quantity)||1); const unitCost=Math.max(0,Number(req.body?.unitCost)||0); const salePrice=Math.max(0,Number(req.body?.salePrice)||0);
  if(!name)return res.status(400).json({error:'اسم القطعة مطلوب'});
  const client=await pool.connect(); try{await client.query('BEGIN');await setTenant(client,req.user.shop_id);
    const sp=(await client.query(`INSERT INTO spare_parts(shop_id,name,quantity,cost_price,sale_price) VALUES($1,$2,0,$3,$4) RETURNING id`,[req.user.shop_id,name,unitCost,salePrice])).rows[0];
    const rp=(await client.query(`INSERT INTO repair_parts(shop_id,repair_id,part_id,quantity,unit_cost,sale_price,added_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.user.shop_id,req.params.id,sp.id,qty,unitCost,salePrice,req.user.id])).rows[0];
    await client.query(`UPDATE repair_orders SET part_cost=COALESCE(part_cost,0)+($1*$2), updated_at=NOW(), updated_by=$3 WHERE id=$4`,[qty,unitCost,req.user.id,req.params.id]);
    await client.query('COMMIT'); res.status(201).json({...rp,part_name:name});
  }catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'تعذر إضافة قطعة الغيار'})}finally{client.release()}
});
app.delete("/api/repairs/:id/parts/:partId",auth,can("edit_repair"),async(req,res)=>{try{const r=await one(`DELETE FROM repair_parts WHERE id=$1 AND repair_id=$2 RETURNING *`,[req.params.partId,req.params.id]);if(!r)return res.status(404).json({error:'القطعة غير موجودة'});await q(`UPDATE repair_orders SET part_cost=GREATEST(0,COALESCE(part_cost,0)-($1*$2)),updated_at=NOW(),updated_by=$3 WHERE id=$4`,[r.quantity,r.unit_cost,req.user.id,req.params.id]);res.json({ok:true})}catch(e){res.status(500).json({error:'تعذر حذف القطعة'})}});
app.delete("/api/repairs/:id",auth,can("delete_repairs"),async(req,res)=>{
  try{
    const r=await one("SELECT id,receipt_no,tracking_code FROM repair_orders WHERE id=$1",[req.params.id]);
    if(!r)return res.status(404).json({error:"الوصل غير موجود"});
    await log(req.user.id,"حذف الوصل",r.id,{receipt_no:r.receipt_no,tracking_code:r.tracking_code});
    await pool.query("DELETE FROM repair_orders WHERE id=$1",[r.id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"تعذر حذف الوصل"})}
});

app.patch("/api/repairs/:id/status",auth,can("change_status"),async(req,res)=>{
  const status=req.body.status;
  if(!STATUSES.includes(status))return res.status(400).json({error:"حالة غير صالحة"});
  const r=await one("UPDATE repair_orders SET status=$1,updated_by=$2,updated_at=NOW() WHERE id=$3 RETURNING *",[status,req.user.id,req.params.id]);
  if(!r)return res.status(404).json({error:"غير موجود"});
  await q("INSERT INTO repair_status_history(shop_id,repair_id,status,changed_by) VALUES($1,$2,$3,$4)",[req.user.shop_id,r.id,status,req.user.id]);
  let whatsapp=null;
  if(status==='تم اصلاحه'){
    const phone=(await one('SELECT phone FROM customers WHERE id=$1',[r.customer_id]))?.phone||'';
    const msg=`مرحبًا، نعلمكم أن هاتفكم في BN SMART أصبح جاهزًا للاستلام.\nرقم الوصل: #${r.receipt_no}\n${r.brand||''} ${r.model||''}\nمتابعة الحالة: ${req.protocol}://${req.get('host')}/track/${encodeURIComponent(r.tracking_code)}`;
    await q(`INSERT INTO notifications(shop_id,repair_id,channel,message,created_by) VALUES($1,$2,'whatsapp',$3,$4)`,[req.user.shop_id,r.id,msg,req.user.id]);
    const digits=String(phone).replace(/\D/g,'');
    const intl=digits.startsWith('0')?'213'+digits.slice(1):digits;
    whatsapp={phone:intl,message:msg,url:`https://wa.me/${intl}?text=${encodeURIComponent(msg)}`};
  }
  await log(req.user.id,"تغيير حالة الإصلاح",r.id,{status});
  res.json({...r,whatsapp});
});

app.patch("/api/repairs/:id/received",auth,can("edit_repair"),async(req,res)=>{
  try{
    const raw=req.body?.received;
    const received = raw===true || raw==="true" || raw===1 || raw==="1";
    const r=await one(
      `UPDATE repair_orders
       SET customer_received=$1,
           received_at=CASE WHEN $1 THEN COALESCE(received_at,NOW()) ELSE NULL END,
           updated_by=$2, updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [received,req.user.id,req.params.id]
    );
    if(!r)return res.status(404).json({error:"الوصل غير موجود"});
    // Logging must never turn a successful status update into a 500 response.
    try{
      await log(req.user.id,received?"تم استلام الجهاز من طرف الزبون":"إلغاء تأكيد استلام الجهاز",r.id,{customer_received:received});
    }catch(logErr){ console.error("pickup log error:",logErr); }
    res.json(r);
  }catch(e){
    console.error("pickup update error:",e);
    res.status(500).json({error:"تعذر تحديث حالة الاستلام",detail:process.env.NODE_ENV==="production"?undefined:e.message});
  }
});

app.post("/api/repairs/:id/payments",auth,can("edit_repair"),async(req,res)=>{
  const amount=Number(req.body.amount)||0;
  if(amount<=0)return res.status(400).json({error:"قيمة الدفعة غير صحيحة"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await setTenant(client,req.user.shop_id);
    const r=(await client.query("UPDATE repair_orders SET paid_amount=paid_amount+$1,updated_by=$2,updated_at=NOW() WHERE id=$3 RETURNING *",[amount,req.user.id,req.params.id])).rows[0];
    if(!r){await client.query("ROLLBACK");return res.status(404).json({error:"غير موجود"})}
    await client.query("INSERT INTO payments(shop_id,repair_id,amount,recorded_by) VALUES($1,$2,$3,$4)",[req.user.shop_id,r.id,amount,req.user.id]);
    await client.query("COMMIT");await log(req.user.id,"تسجيل دفعة",r.id,{amount});res.json(r);
  }catch(e){await client.query("ROLLBACK");res.status(500).json({error:"تعذر تسجيل الدفعة"})}finally{client.release()}
});

app.get("/api/customers",auth,can("customers"),async(req,res)=>{
  res.json(await q(`SELECT c.id,c.name,c.phone,COUNT(r.id)::int repairs_count,COALESCE(SUM(r.paid_amount),0) paid,COALESCE(SUM(r.expected_price-r.paid_amount),0) remaining,MAX(r.created_at) last_visit
  FROM customers c LEFT JOIN repair_orders r ON r.customer_id=c.id GROUP BY c.id ORDER BY last_visit DESC NULLS LAST`));
});

app.post("/api/customers",auth,can("customers"),async(req,res)=>{
  const name=String(req.body?.name||"").trim();
  const phone=String(req.body?.phone||"").trim();
  if(!name || !phone) return res.status(400).json({error:"اسم الزبون ورقم الهاتف مطلوبان"});
  try{
    const existing=await one("SELECT id,name,phone FROM customers WHERE shop_id=$1 AND phone=$2 ORDER BY id LIMIT 1",[req.user.shop_id,phone]);
    if(existing) return res.status(409).json({error:"رقم الهاتف مسجل مسبقًا لهذا الزبون",customer:existing});
    const c=await one("INSERT INTO customers(shop_id,name,phone) VALUES($1,$2,$3) RETURNING id,name,phone,created_at",[req.user.shop_id,name,phone]);
    await log(req.user.id,"إضافة زبون",null,{customer_id:c.id});
    res.status(201).json(c);
  }catch(e){console.error(e);res.status(500).json({error:"تعذر إضافة الزبون"})}
});

app.post("/api/auth/change-password", auth, async(req,res)=>{
  const {currentPassword,newPassword}=req.body||{};
  if(!currentPassword || !newPassword) return res.status(400).json({error:"يرجى إدخال كلمة المرور الحالية والجديدة"});
  if(String(newPassword).length < 8) return res.status(400).json({error:"كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل"});
  const u=await one("SELECT * FROM users WHERE id=$1",[req.user.id]);
  if(!u || !u.active || !(await bcrypt.compare(String(currentPassword),u.password_hash))) return res.status(400).json({error:"كلمة المرور الحالية غير صحيحة"});
  const hash=await bcrypt.hash(String(newPassword),12);
  await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[hash,u.id]);
  await log(req.user.id,"تغيير كلمة المرور",null);
  res.json({ok:true});
});

app.get("/api/users",auth,manager,async(req,res)=>{
  res.json(await q("SELECT id,username,full_name,phone,role,active,permissions,last_login,created_at FROM users ORDER BY id"));
});
app.post("/api/users",auth,manager,async(req,res)=>{
  const b=req.body;if(!b.username||!b.fullName||!b.password)return res.status(400).json({error:"البيانات الأساسية مطلوبة"});
  const hash=await bcrypt.hash(b.password,12);
  const permissions={...DEFAULT_PERMS,...(b.permissions||{})};
  try{
    const u=await one("INSERT INTO users(shop_id,username,full_name,phone,password_hash,role,permissions) VALUES($1,$2,$3,$4,$5,'collaborator',$6) RETURNING id,username,full_name,phone,role,active,permissions",
      [req.user.shop_id,b.username,b.fullName,b.phone||"",hash,JSON.stringify(permissions)]);
    await log(req.user.id,"إضافة متعاون",null,{username:b.username});res.status(201).json(u);
  }catch(e){res.status(409).json({error:"اسم المستخدم مستخدم بالفعل"})}
});
app.patch("/api/users/:id",auth,manager,async(req,res)=>{
  const b=req.body;let u=await one("SELECT * FROM users WHERE id=$1",[req.params.id]);if(!u)return res.status(404).json({error:"المستخدم غير موجود"});
  const username=b.username==null?u.username:String(b.username).trim();
  if(!username)return res.status(400).json({error:"اسم المستخدم مطلوب"});
  const role=b.role==null?u.role:String(b.role);
  if(!["manager","collaborator"].includes(role))return res.status(400).json({error:"الدور غير صالح"});
  const active=b.active==null?u.active:Boolean(b.active);
  if((u.role!==role || u.active!==active) && (u.role==="manager") && (role!=="manager" || !active)){
    const count=Number((await one("SELECT COUNT(*)::int n FROM users WHERE role='manager' AND active=true"))?.n||0);
    if(count<=1)return res.status(400).json({error:"يجب أن يبقى مدير واحد فعّال على الأقل"});
  }
  const perms=role==="manager"?JSON.stringify(Object.fromEntries(Object.keys(DEFAULT_PERMS).map(k=>[k,true]))):JSON.stringify(b.permissions?{...DEFAULT_PERMS,...b.permissions}:u.permissions||{});
  const passwordHash=b.password?await bcrypt.hash(b.password,12):u.password_hash;
  try{
    u=await one("UPDATE users SET username=$1,full_name=COALESCE($2,full_name),phone=COALESCE($3,phone),role=$4,active=$5,permissions=$6,password_hash=$7 WHERE id=$8 RETURNING id,username,full_name,phone,role,active,permissions,last_login",
      [username,b.fullName,b.phone,role,active,perms,passwordHash,req.params.id]);
    await log(req.user.id,"تعديل حساب مستخدم",null,{user_id:u.id,username:u.username,role:u.role});res.json(u);
  }catch(e){
    if(e && e.code==="23505") return res.status(409).json({error:"اسم المستخدم مستخدم بالفعل"});
    console.error(e);res.status(500).json({error:"تعذر تعديل الحساب"});
  }
});
app.post("/api/users/:id/password",auth,manager,async(req,res)=>{
  const b=req.body||{};
  if(!b.newPassword || String(b.newPassword).length<8)return res.status(400).json({error:"كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل"});
  const u=await one("SELECT id,username,role FROM users WHERE id=$1",[req.params.id]);
  if(!u)return res.status(404).json({error:"المستخدم غير موجود"});
  const hash=await bcrypt.hash(String(b.newPassword),12);
  await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[hash,u.id]);
  await log(req.user.id,"تغيير كلمة مرور مستخدم",null,{user_id:u.id,username:u.username});
  res.json({ok:true});
});
app.put("/api/users/:id/password",auth,manager,async(req,res)=>{
  const b=req.body||{};
  if(!b.newPassword || String(b.newPassword).length<8)return res.status(400).json({error:"كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل"});
  const u=await one("SELECT id,username,role FROM users WHERE id=$1",[req.params.id]);
  if(!u)return res.status(404).json({error:"المستخدم غير موجود"});
  try{
    const hash=await bcrypt.hash(String(b.newPassword),12);
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[hash,u.id]);
    await log(req.user.id,"تغيير كلمة مرور مستخدم",null,{user_id:u.id,username:u.username});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"تعذر تغيير كلمة المرور"})}
});

app.delete("/api/users/:id",auth,manager,async(req,res)=>{
  if(Number(req.params.id)===req.user.id)return res.status(400).json({error:"لا يمكنك حذف حسابك الحالي"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await setTenant(client,req.user.shop_id);
    const u=(await client.query("SELECT id,username,full_name,role FROM users WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0];
    if(!u)return res.status(404).json({error:"المستخدم غير موجود"});
    if(u.role==="manager") {
      const managers=Number((await client.query("SELECT COUNT(*)::int n FROM users WHERE role='manager' AND active=true AND id<>$1",[u.id])).rows[0].n||0);
      if(managers<1)return res.status(403).json({error:"لا يمكن حذف المدير الوحيد. يجب أن يوجد مدير آخر فعّال أولًا"});
    }
    const label=`${u.full_name} (${u.username})`;
    await client.query("UPDATE activity_logs SET user_id=NULL, details=jsonb_set(COALESCE(details,'{}'::jsonb), '{deleted_user_name}', to_jsonb($1::text), true) WHERE user_id=$2",[label,u.id]);
    await client.query("UPDATE repair_orders SET created_by=NULL, updated_by=NULL WHERE created_by=$1 OR updated_by=$1",[u.id]);
    await client.query("UPDATE repair_status_history SET changed_by=NULL WHERE changed_by=$1",[u.id]);
    await client.query("UPDATE payments SET recorded_by=NULL WHERE recorded_by=$1",[u.id]);
    await client.query("UPDATE repair_parts SET added_by=NULL WHERE added_by=$1",[u.id]);
    await client.query("UPDATE inventory_transactions SET performed_by=NULL WHERE performed_by=$1",[u.id]);
    await client.query("UPDATE notifications SET created_by=NULL WHERE created_by=$1",[u.id]);
    await client.query("DELETE FROM users WHERE id=$1",[u.id]);
    await client.query("INSERT INTO activity_logs(shop_id,user_id,action,details) VALUES($1,$2,$3,$4)",[req.user.shop_id,req.user.id,"حذف حساب متعاون",JSON.stringify({deleted_user_id:u.id,deleted_user_name:label})]);
    await client.query("COMMIT");
    res.json({ok:true});
  }catch(e){await client.query("ROLLBACK");console.error(e);res.status(500).json({error:e?.code==="23503"?"لا يمكن حذف هذا الحساب بسبب ارتباط بيانات به":"تعذر حذف الحساب"});}
  finally{client.release()}
});
app.get("/api/activity",auth,manager,async(req,res)=>{
  res.json(await q(`SELECT a.*,u.full_name user_name,r.receipt_no FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN repair_orders r ON r.id=a.repair_id ORDER BY a.created_at DESC LIMIT 300`));
});

const SUPPLIER_NAMES=["BN SMART","MONTEL","AABIDIN","HASSAN","RAHT ELBAL"];
const SUPPLIER_ITEMS=["LCD","BAT","NAP CHARGE","GLASS","SERSOU","CONCTOUR"];
app.get("/api/suppliers",auth,can("inventory"),async(req,res)=>{
  try{const rows=await q(`SELECT supplier,COUNT(*)::int purchases_count,COALESCE(SUM(total_amount),0)::numeric total,COALESCE(SUM(paid_amount),0)::numeric paid,COALESCE(SUM(total_amount-paid_amount),0)::numeric remaining,MAX(created_at) last_purchase FROM supplier_purchases GROUP BY supplier`);const by=new Map(rows.map(r=>[r.supplier,r]));res.json(SUPPLIER_NAMES.map(name=>({supplier:name,purchases_count:0,total:0,paid:0,remaining:0,last_purchase:null,...(by.get(name)||{})})));}catch(e){console.error(e);res.status(500).json({error:"تعذر تحميل الموردين"})}
});
app.get("/api/suppliers/:supplier/purchases",auth,can("inventory"),async(req,res)=>{const supplier=String(req.params.supplier||"").trim();if(!SUPPLIER_NAMES.includes(supplier))return res.status(400).json({error:"المورد غير صالح"});res.json(await q(`SELECT sp.*,u.full_name created_by_name FROM supplier_purchases sp LEFT JOIN users u ON u.id=sp.created_by WHERE sp.supplier=$1 ORDER BY sp.created_at DESC`,[supplier]));});
app.post("/api/suppliers/purchases",auth,can("inventory"),async(req,res)=>{const b=req.body||{},supplier=String(b.supplier||"").trim();if(!SUPPLIER_NAMES.includes(supplier))return res.status(400).json({error:"اختر موردًا صالحًا"});const raw=Array.isArray(b.items)?b.items:[];const items=raw.map(x=>({type:String(x.type||"").trim(),variant:String(x.variant||"").trim(),model:String(x.model||"").trim(),qty:Math.max(1,Math.floor(Number(x.qty)||1)),unitPrice:Math.max(0,Number(x.unitPrice)||0)})).filter(x=>SUPPLIER_ITEMS.includes(x.type));if(!items.length)return res.status(400).json({error:"اختر سلعة واحدة على الأقل"});if(items.some(x=>x.type==="LCD"&&!['ORG','OLD','INSEL'].includes(x.variant)))return res.status(400).json({error:"اختر نوع LCD: ORG أو OLD أو INSEL"});const total=items.reduce((n,x)=>n+x.qty*x.unitPrice,0),paid=Math.max(0,Math.min(total,Number(b.paid)||0));try{const r=await one(`INSERT INTO supplier_purchases(shop_id,supplier,items,total_amount,paid_amount,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.user.shop_id,supplier,JSON.stringify(items),total,paid,String(b.notes||""),req.user.id]);await log(req.user.id,"إضافة شراء من مورد",null,{supplier,total,paid,items});res.status(201).json(r);}catch(e){console.error(e);res.status(500).json({error:"تعذر حفظ شراء المورد"})}});
app.delete("/api/suppliers/purchases/:id",auth,manager,async(req,res)=>{try{const r=await one("DELETE FROM supplier_purchases WHERE id=$1 RETURNING *",[req.params.id]);if(!r)return res.status(404).json({error:"عملية الشراء غير موجودة"});await log(req.user.id,"حذف شراء مورد",null,{purchase_id:r.id,supplier:r.supplier});res.json({ok:true});}catch(e){console.error(e);res.status(500).json({error:"تعذر حذف عملية الشراء"})}});

app.get("/api/settings",auth,can("settings"),async(req,res)=>{
  const value=(await one("SELECT value FROM settings WHERE key='shop'"))?.value||{};
  res.json({...value,name:"BN SMART"});
});
app.put("/api/settings",auth,manager,async(req,res)=>{
  const current=(await one("SELECT value FROM settings WHERE key='shop'"))?.value||{};
  const next={...current,...req.body,name:"BN SMART"};
  await pool.query("INSERT INTO settings(shop_id,key,value) VALUES($1,'shop',$2) ON CONFLICT(shop_id,key) DO UPDATE SET value=EXCLUDED.value",[req.user.shop_id,JSON.stringify(next)]);
  await log(req.user.id,"تحديث إعدادات المحل");res.json(next);
});

app.get("/api/backup",auth,manager,async(req,res)=>{
  const data={customers:await q("SELECT * FROM customers"),repairs:await q("SELECT * FROM repair_orders"),supplier_purchases:await q("SELECT * FROM supplier_purchases"),history:await q("SELECT * FROM repair_status_history"),payments:await q("SELECT * FROM payments"),users:await q("SELECT id,username,full_name,phone,role,active,permissions,last_login,created_at FROM users"),settings:await q("SELECT * FROM settings"),activity:await q("SELECT * FROM activity_logs")};
  res.json({exported_at:new Date().toISOString(),data});
});

app.get("/api/track/:code",async(req,res)=>{
  const r=await one(`SELECT * FROM public_track_repair($1)`,[req.params.code]);
  if(!r)return res.status(404).json({error:"رقم التتبع غير موجود"});
  const history=await one(`SELECT public_track_history($1) AS rows`,[r.id]);
  const historyRows=history?.rows||[];
  res.json({receipt_no:r.receipt_no,tracking_code:r.tracking_code,device:[r.brand,r.model].filter(Boolean).join(" "),brand:r.brand,model:r.model,customer_name:r.customer_name,customer_phone:r.customer_phone,fault:r.fault,expected_price:r.expected_price,paid_amount:r.paid_amount,remaining:Math.max(0,Number(r.expected_price||0)-Number(r.paid_amount||0)),accessories:r.accessories||[],status:r.status,updated_at:r.updated_at,history:historyRows});
});
app.get("/api/qr/:code",async(req,res)=>{try{const base=`${req.protocol}://${req.get("host")}`;const png=await QRCode.toBuffer(`${base}/track/${encodeURIComponent(req.params.code)}`,{width:360,margin:2});res.type("png").send(png)}catch(e){res.status(500).end()}});

app.get("/track/:code",(req,res)=>res.sendFile(path.join(__dirname,"public","track.html")));
app.get("/share/:code",(req,res)=>{res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.set("Pragma","no-cache");res.set("Expires","0");res.sendFile(path.join(__dirname,"public","share.html"));});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

init().then(()=>app.listen(PORT,()=>console.log(`BN SMART running on http://localhost:${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
