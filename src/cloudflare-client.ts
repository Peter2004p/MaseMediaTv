/** Cloudflare Pages API adapter starter. Not wired into App.tsx until auth and routes are ported. */
type ApiResult<T=any> = { data:T };
async function request<T=any>(method:string,path:string,body?:unknown,params?:Record<string,string>):Promise<ApiResult<T>> {
  const url=new URL(path,window.location.origin);
  if(params) for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
  const response=await fetch(url.toString(),{method,credentials:"include",headers:body===undefined?{}:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();
  let data:any={}; try{data=text?JSON.parse(text):{}}catch{data={message:text}}
  if(!response.ok) throw new Error(data?.error||data?.message||`Request failed (${response.status})`);
  return {data};
}
export const api={
 get:<T=any>(path:string,params?:Record<string,string>)=>request<T>("GET",path,undefined,params),
 post:<T=any>(path:string,body?:unknown)=>request<T>("POST",path,body),
 put:<T=any>(path:string,body?:unknown)=>request<T>("PUT",path,body),
 delete:<T=any>(path:string)=>request<T>("DELETE",path),
};
/** Cookie-backed Google and Telegram authentication. */
export const auth={
 getUser:async()=>{const r=await request<{user?:any}>("GET","/api/auth/me");return r.data?.user||null;},
 signIn:async():Promise<any>=>{window.location.assign("/api/auth/google");return await new Promise<any>(()=>{});},
 signOut:async()=>{await request("POST","/api/auth/logout");},
};
/** Keep image resizing local; the backend must validate uploads and store them in R2. */
export const image={
 resizeIfNeeded:async(file:File,opts:{maxDimension:number;maxPixels:number;quality:number;mimeType:string})=>{
  if(!file.type.startsWith("image/")) throw new Error("Expected an image file");
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(1,opts.maxDimension/Math.max(bitmap.width,bitmap.height),Math.sqrt(opts.maxPixels/(bitmap.width*bitmap.height)));
  const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Image processing is unavailable");
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Image compression failed")),opts.mimeType,opts.quality));
  return {data:await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||"").split(",")[1]||"");reader.onerror=()=>reject(new Error("Could not read compressed image"));reader.readAsDataURL(blob)}),mimeType:blob.type};
 }
};
