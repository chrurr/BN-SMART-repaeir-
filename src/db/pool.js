const {Pool}=require("pg");
const {AsyncLocalStorage}=require("async_hooks");
const {DATABASE_URL}=require("../config");
const tenantContext=new AsyncLocalStorage();
const pool = new Pool({connectionString: DATABASE_URL});

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
async function q(text, params=[]){ return (await pool.query(text,params)).rows; }
async function one(text, params=[]){ return (await pool.query(text,params)).rows[0]; }
async function log(userId,action,repairId=null,details={}){const ctx=tenantContext.getStore();await pool.query("INSERT INTO activity_logs(shop_id,user_id,action,repair_id,details) VALUES($1,$2,$3,$4,$5)",[ctx?.shopId||null,userId,action,repairId,JSON.stringify(details)])}
module.exports={pool,tenantContext,setTenant,q,one,log};
