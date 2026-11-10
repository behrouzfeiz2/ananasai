const API="https://api.appalpha.ir/v1";
const out=(d,s=200,extra={})=>new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, X-User-Token","Access-Control-Allow-Methods":"GET, POST, OPTIONS",...extra}});
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tehran"}).format(new Date());
async function auth(req,env){
  if(!env.ALPHA_KEY||!env.ANANAS_KV)return{error:"تنظیمات سرویس تصویر کامل نیست.",status:503};
  const token=(req.headers.get("X-User-Token")||"").trim();
  if(!token)return{error:"فقط کاربران Ultra مجاز هستند.",status:403};
  const raw=await env.ANANAS_KV.get(token);if(!raw)return{error:"کد فعال‌سازی نامعتبر است.",status:401};
  let d={};try{d=JSON.parse(raw)}catch{}
  if(d.tier!=="ultra"&&!token.startsWith("ULTRA-"))return{error:"فقط کاربران Ultra مجاز هستند.",status:403};
  return{token,key:"image_ultra_"+token+"_"+today()};
}
async function tokenHash(token){const bytes=new TextEncoder().encode(token),digest=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function release(env,key){try{const q=JSON.parse(await env.ANANAS_KV.get(key)||"{}");q.used=Math.max(0,(Number(q.used)||0)-1);await env.ANANAS_KV.put(key,JSON.stringify(q),{expirationTtl:172800});}catch{}}
async function saveToLibrary(env,token,id,url,prompt,model){
  const hash=await tokenHash(token),prefix="imgdata_"+hash+"_"+id;
  const existing=await env.ANANAS_KV.get("imgmeta_"+hash+"_"+id);
  if(existing)return true;
  const response=await fetch(url);
  if(!response.ok)throw new Error("دانلود تصویر تولیدشده ناموفق بود.");
  const type=(response.headers.get("content-type")||"image/png").split(";")[0].trim();
  if(!/^image\/(png|jpeg|webp|gif)$/.test(type))throw new Error("فرمت تصویر خروجی پشتیبانی نمی‌شود.");
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength>24*1024*1024)throw new Error("حجم تصویر برای ذخیره در کتابخانه بیش از حد مجاز است.");
  await env.ANANAS_KV.put(prefix,bytes,{expirationTtl:31536000});
  const meta={id, name:String(prompt||"تصویر تولیدشده").slice(0,180),model,createdAt:new Date().toISOString(),contentType:type,size:bytes.byteLength};
  await env.ANANAS_KV.put("imgmeta_"+hash+"_"+id,JSON.stringify(meta),{expirationTtl:31536000});
  return true;
}
export async function onRequestPost({request,env}){
  const u=await auth(request,env);if(u.error)return out({error:u.error},u.status);
  try{
    const b=await request.json(),prompt=String(b.prompt||"").trim(),model=String(b.model||"");
    if(!prompt||prompt.length>4000)return out({error:"متن تصویر الزامی است (حداکثر ۴۰۰۰ نویسه)."},400);
    if(!["flux-dev","z-image","qwen-image-edit"].includes(model))return out({error:"مدل نامعتبر است."},400);
    let referenceUrl=null;
    if(model==="qwen-image-edit"){
      const referenceId=String(b.referenceId||"");
      if(!/^[a-f0-9-]{36}$/i.test(referenceId))return out({error:"تصویر مرجع ارسال نشده یا شناسه آن نامعتبر است."},400);
      const ref=await env.ANANAS_KV.getWithMetadata("imgref_"+referenceId,"arrayBuffer");
      if(!ref||!ref.value||!ref.metadata||ref.metadata.owner!==await tokenHash(u.token))return out({error:"تصویر مرجع منقضی شده یا در دسترس نیست؛ لطفاً دوباره تصویر را ضمیمه کنید."},410);
      referenceUrl=new URL("/api/image-reference?id="+encodeURIComponent(referenceId),request.url).toString();
    }
    const q=JSON.parse(await env.ANANAS_KV.get(u.key)||"{}"),used=Number(q.used)||0;
    if(used>=5)return out({error:"سهمیه روزانه ۵ تصویر شما تمام شده است.",quota:{used,limit:5}},429);
    const r=await fetch(API+"/generations",{method:"POST",headers:{Authorization:"Bearer "+env.ALPHA_KEY,"Content-Type":"application/json"},body:JSON.stringify({model,prompt,width:1024,height:1024,...(referenceUrl?{image:referenceUrl}:{})})});
    const j=await r.json();if(!r.ok||j.error||!j.id)return out({error:j.error?.message||"ثبت درخواست ناموفق بود."},r.status||502);
    await env.ANANAS_KV.put(u.key,JSON.stringify({used:used+1}),{expirationTtl:172800});
    await env.ANANAS_KV.put("imagejob_"+j.id,JSON.stringify({token:u.token,key:u.key,released:false,prompt,model}),{expirationTtl:86400});
    return out({success:true,id:j.id,status:j.status,quota:{used:used+1,limit:5}});
  }catch{return out({error:"ارتباط با سرویس تصویر برقرار نشد."},502);}
}
export async function onRequestGet({request,env}){
  const u=await auth(request,env);if(u.error)return out({error:u.error},u.status);
  const id=new URL(request.url).searchParams.get("id");if(!id)return out({success:true});
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return out({error:"شناسه نامعتبر است."},400);
  const raw=await env.ANANAS_KV.get("imagejob_"+id);if(!raw)return out({error:"درخواست تصویر پیدا نشد."},404);
  let job={};try{job=JSON.parse(raw)}catch{}
  if(job.token!==u.token)return out({error:"دسترسی غیرمجاز."},403);
  try{
    const r=await fetch(API+"/generations/"+id,{headers:{Authorization:"Bearer "+env.ALPHA_KEY}}),d=await r.json();
    if(!r.ok)return out({error:d.error?.message||"خطا در دریافت وضعیت."},r.status);
    if(d.status==="failed"&&!job.released){await release(env,job.key);job.released=true;await env.ANANAS_KV.put("imagejob_"+id,JSON.stringify(job),{expirationTtl:86400});}
    let librarySaved=false;
    if(d.status==="ready"&&d.output?.url){
      try{librarySaved=await saveToLibrary(env,u.token,id,d.output.url,job.prompt,job.model);if(!job.librarySaved){job.librarySaved=true;await env.ANANAS_KV.put("imagejob_"+id,JSON.stringify(job),{expirationTtl:86400});}}
      catch(e){return out({success:true,status:"ready",output:d.output,librarySaved:false,libraryError:e.message});}
    }
    return out({success:true,status:d.status,output:d.output||null,error:d.error||null,librarySaved});
  }catch{return out({error:"دریافت وضعیت تصویر ناموفق بود."},502);}
}
export async function onRequestOptions(){return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, X-User-Token","Access-Control-Allow-Methods":"GET, POST, OPTIONS"}});}
