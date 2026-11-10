async function auth(req,env){
  if(!env.ANANAS_KV)return{error:"فضای ذخیره‌سازی فعال نیست.",status:503};
  const token=(req.headers.get("X-User-Token")||"").trim();if(!token)return{error:"کد فعال‌سازی ارسال نشده است.",status:403};
  const raw=await env.ANANAS_KV.get(token);if(!raw)return{error:"کد فعال‌سازی نامعتبر است.",status:401};
  let d={};try{d=JSON.parse(raw)}catch{}
  if(d.tier!=="ultra"&&!token.startsWith("ULTRA-"))return{error:"کتابخانه تصاویر فقط برای کاربران Ultra فعال است.",status:403};
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
  return{token,hash};
}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, X-User-Token","Access-Control-Allow-Methods":"GET, DELETE, OPTIONS"}});
export async function onRequestGet({request,env}){
  const u=await auth(request,env);if(u.error)return json({error:u.error},u.status);
  const url=new URL(request.url),id=url.searchParams.get("file");
  if(id){
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return json({error:"شناسه نامعتبر است."},400);
    const metaRaw=await env.ANANAS_KV.get("imgmeta_"+u.hash+"_"+id);if(!metaRaw)return json({error:"تصویر پیدا نشد."},404);
    const meta=JSON.parse(metaRaw),bytes=await env.ANANAS_KV.get("imgdata_"+u.hash+"_"+id,"arrayBuffer");
    if(!bytes)return json({error:"فایل تصویر در دسترس نیست."},404);
    return new Response(bytes,{headers:{"Content-Type":meta.contentType||"image/png","Content-Length":String(bytes.byteLength),"Cache-Control":"private, max-age=3600","Content-Disposition":"inline; filename=\"ananas-"+id+"\"","X-Content-Type-Options":"nosniff","Access-Control-Allow-Origin":"*"}});
  }
  const listed=await env.ANANAS_KV.list({prefix:"imgmeta_"+u.hash+"_",limit:1000}),items=[];
  for(const key of listed.keys){const raw=await env.ANANAS_KV.get(key.name);if(raw){try{items.push(JSON.parse(raw))}catch{}}}
  items.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  return json({success:true,items});
}
export async function onRequestDelete({request,env}){
  const u=await auth(request,env);if(u.error)return json({error:u.error},u.status);
  const id=new URL(request.url).searchParams.get("file");if(!id||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return json({error:"شناسه نامعتبر است."},400);
  await env.ANANAS_KV.delete("imgdata_"+u.hash+"_"+id);await env.ANANAS_KV.delete("imgmeta_"+u.hash+"_"+id);
  return json({success:true});
}
export async function onRequestOptions(){return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, X-User-Token","Access-Control-Allow-Methods":"GET, DELETE, OPTIONS"}});}
