const json=(data,status=410)=>new Response(JSON.stringify(data),{
  status,
  headers:{
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type, X-User-Token",
    "Access-Control-Allow-Methods":"GET, DELETE, OPTIONS"
  }
});

// تصاویر تولیدشده دیگر در فضای ابری کتابخانه نمی‌شوند؛
 // کتابخانه تصاویر از IndexedDB دستگاه کاربر تغذیه می‌شود.
export async function onRequestGet(){
  return json({error:"کتابخانه تصاویر اکنون فقط روی دستگاه شما در دسترس است."},410);
}
export async function onRequestDelete(){
  return json({error:"برای حذف تصویر، آن را از کتابخانه محلی داخل برنامه پاک کنید."},410);
}
export async function onRequestOptions(){
  return new Response(null,{status:204,headers:{
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type, X-User-Token",
    "Access-Control-Allow-Methods":"GET, DELETE, OPTIONS"
  }});
}
