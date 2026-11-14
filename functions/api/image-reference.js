const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, X-User-Token","Access-Control-Allow-Methods":"GET, POST, OPTIONS"}});
async function auth(req,env){
  try{
    if(!env.ANANAS_KV)return{error:"فضای ذخیره‌سازی فعال نیست.",status:503};
    const token=(req.headers.get("X-User-Token")||"").trim();
    if(!token)return{error:"فقط کاربران Ultra مجاز هستند.",status:403};
    const raw=await env.ANANAS_KV.get(token);if(!raw)return{error:"کد فعال‌سازی نامعتبر است.",status:401};
    let d={};try{d=JSON.parse(raw)}catch{}
    if(d.tier!=="ultra"&&!token.startsWith("ULTRA-"))return{error:"فقط کاربران Ultra مجاز هستند.",status:403};
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
    const owner=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
    return{owner};
  }catch{return{error:"بررسی دسترسی تصویر مرجع ناموفق بود؛ اتصال فضای ذخیره‌سازی را بررسی کنید.",status:503};}
}
export async function onRequestPost({request,env}){
  const u=await auth(request,env);if(u.error)return json({error:u.error},u.status);
  try{
    const b=await request.json(),mime=String(b.mimeType||""),data=String(b.data||"");
    if(!/^image\/(png|jpeg|webp)$/.test(mime))return json({error:"فقط تصاویر PNG، JPG و WebP قابل ویرایش هستند."},415);
    if(!data||data.length>11*1024*1024)return json({error:"حجم تصویر بیش از حد مجاز است (حداکثر ۸ مگابایت)."},413);
    const binary=atob(data),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    if(!bytes.length||bytes.length>8*1024*1024)return json({error:"حجم تصویر بیش از حد مجاز است (حداکثر ۸ مگابایت)."},413);
    const id=crypto.randomUUID();
    await env.ANANAS_KV.put("imgref_"+id,bytes,{expirationTtl:1800,metadata:{owner:u.owner,contentType:mime}});
    return json({success:true,referenceId:id,expiresIn:1800});
  }catch{return json({error:"بارگذاری تصویر مرجع ناموفق بود."},400);}
}
export async function onRequestGet({request,env}){
  try{
    const id=new URL(request.url).searchParams.get("id");
    if(!id||!/^[a-f0-9-]{36}$/i.test(id))return new Response("Not found",{status:404});
    const item=await env.ANANAS_KV.getWithMetadata("imgref_"+id,"arrayBuffer");
    if(!item||!item.value||!item.metadata||!item.metadata.contentType)return new Response("Not found",{status:404});
    return new Response(item.value,{headers:{"Content-Type":item.metadata.contentType,"Content-Length":String(item.value.byteLength),"Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff"}});
  }catch{return new Response("Image reference unavailable",{status:503,headers:{"Cache-Control":"no-store"}});}
}
export async function onRequestOptions(){return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, X-User-Token","Access-Control-Allow-Methods":"GET, POST, OPTIONS"}});}
