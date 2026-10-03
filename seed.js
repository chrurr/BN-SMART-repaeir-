require("dotenv").config();
const {Pool}=require("pg"),bcrypt=require("bcryptjs");
(async()=>{
 const pool=new Pool({connectionString:process.env.DATABASE_URL});
 const schema=require("fs").readFileSync("db/schema.sql","utf8"); await pool.query(schema);
 const h=await bcrypt.hash("Admin@12345",12);
 await pool.query(`INSERT INTO users(username,full_name,password_hash,role,permissions) VALUES('admin','المدير الرئيسي',$1,'manager',$2)
 ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,active=true`,
 [h,JSON.stringify(Object.fromEntries(Object.keys({add_repair:1,view_repairs:1,edit_repair:1,change_status:1,customers:1,edit_customers:1,inventory:1,accounts:1,profits:1,reports:1,delete_repairs:1,delete_customers:1,users:1,settings:1,activity_logs:1,backups:1}).map(k=>[k,true])))]);
 console.log("Admin login: admin / Admin@12345"); await pool.end();
})();