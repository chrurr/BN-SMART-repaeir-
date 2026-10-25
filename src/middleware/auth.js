const jwt=require("jsonwebtoken");
const {JWT_SECRET}=require("../config");
const {one,tenantContext}=require("../db/pool");
function auth(req,res,next){
  const h=req.headers.authorization||"";
  const token=h.startsWith("Bearer ")?h.slice(7):null;
  if(!token)return res.status(401).json({error:"تسجيل الدخول مطلوب"});
  let payload;
  try{ payload=jwt.verify(token,JWT_SECRET); }catch(e){ return res.status(401).json({error:"الجلسة غير صالحة"}); }
  if(!payload.shop_id)return res.status(401).json({error:"الجلسة لا تحتوي على محل صالح"});
  // Role, permissions and active state are read from the database on every request,
  // so deactivating a user or changing their permissions takes effect immediately.
  tenantContext.run({shopId:payload.shop_id},async()=>{
    try{
      const u=await one("SELECT id,username,full_name,role,active,permissions,shop_id FROM users WHERE id=$1 AND shop_id=$2",[payload.id,payload.shop_id]);
      if(!u || !u.active)return res.status(401).json({error:"الحساب غير مفعل"});
      req.user={...payload,id:u.id,username:u.username,full_name:u.full_name,role:u.role,permissions:u.permissions||{},shop_id:u.shop_id};
      next();
    }catch(e){console.error(e);res.status(500).json({error:"خطأ في الخادم"})}
  });
}
function manager(req,res,next){ if(req.user.role!=="manager")return res.status(403).json({error:"هذه العملية للمدير فقط"}); next(); }
function can(permission){return (req,res,next)=>{ if(req.user.role==="manager" || req.user.permissions?.[permission]) return next(); res.status(403).json({error:"لا تملك هذه الصلاحية"}); }}
// Finance (prices, payments, profits) is manager-only. Workers still create repairs,
// but the API never returns money fields to them.
const REPAIR_MONEY=["expected_price","paid_amount","part_cost","labor_fee"];
function dropKeys(row,keys){ if(!row)return row; const out={...row}; for(const k of keys) delete out[k]; return out; }
function moneyVisible(req){ return req.user?.role==="manager"; }
module.exports={auth,manager,can,REPAIR_MONEY,dropKeys,moneyVisible};
