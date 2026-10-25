const DEFAULT_PERMS = {
  add_repair:true, view_repairs:true, edit_repair:true, change_status:true,
  customers:true, edit_customers:true, inventory:true, accounts:false,
  profits:false, reports:false, delete_repairs:false, delete_customers:false,
  users:false, settings:false, activity_logs:false, backups:false
};
const STATUSES = ["قيد الاصلاح","تم اصلاحه","لايصلح"];
const SUPPLIER_NAMES=["BN SMART","MONTEL","AABIDIN","HASSAN","RAHT ELBAL"];
const SUPPLIER_ITEMS=["LCD","BAT","NAP CHARGE","GLASS","SERSOU","CONCTOUR"];
module.exports={DEFAULT_PERMS,STATUSES,SUPPLIER_NAMES,SUPPLIER_ITEMS};
