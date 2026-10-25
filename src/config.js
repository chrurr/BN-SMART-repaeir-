require("dotenv").config();
const path=require("path");
for(const key of ["DATABASE_URL","JWT_SECRET"]){
  if(!process.env[key]) throw new Error(key+" is required");
}
module.exports={
  PORT:Number(process.env.PORT||3000),
  DATABASE_URL:process.env.DATABASE_URL,
  JWT_SECRET:process.env.JWT_SECRET,
  DEFAULT_ADMIN_PASSWORD:process.env.DEFAULT_ADMIN_PASSWORD||"Admin@12345",
  NODE_ENV:process.env.NODE_ENV||"development",
  ROOT:path.resolve(__dirname,".."),
  PUBLIC_DIR:path.resolve(__dirname,"..","public"),
};
