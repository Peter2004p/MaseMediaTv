/** Cookie-backed Cloudflare Pages API and authentication adapter used by the MaseNet application. */
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';

type ApiResult<T=any> = { data:T };
async function request<T=any>(method:string,path:string,body?:unknown,params?:Record<string,string>):Promise<ApiResult<T>> {
  const url=new URL(path,window.location.origin);
  if(params) for(const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
  const headers:Record<string,string>={};
  if(body!==undefined)headers["Content-Type"]="application/json";
  const profileId=url.searchParams.get("profileId")||(body&&typeof body==="object"&&"profileId" in body?String((body as any).profileId||""):"");
  if(profileId){try{const unlock=sessionStorage.getItem("masenet-profile-unlock-"+profileId);if(unlock)headers["X-MaseNet-Profile-Unlock"]=unlock}catch{}}
  const response=await fetch(url.toString(),{method,credentials:"include",headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();
  let data:any={}; try{data=text?JSON.parse(text):{}}catch{data={message:text}}
  if(!response.ok){if(response.status===423&&profileId){try{sessionStorage.removeItem("masenet-profile-unlock-"+profileId)}catch{}}throw new Error(data?.error||data?.message||`Request failed (${response.status})`);}
  return {data};
}
export const api={
 get:<T=any>(path:string,params?:Record<string,string>)=>request<T>("GET",path,undefined,params),
 post:<T=any>(path:string,body?:unknown)=>request<T>("POST",path,body),
 put:<T=any>(path:string,body?:unknown)=>request<T>("PUT",path,body),
 delete:<T=any>(path:string)=>request<T>("DELETE",path),
};

let nativeAuthResolver:((user:any)=>void)|null=null;
let nativeAuthRejecter:((error:Error)=>void)|null=null;
async function completeNativeAuthUrl(rawUrl:string){
  if(!rawUrl.startsWith('tv.masemedia.masenet://auth'))return;
  const url=new URL(rawUrl);
  const code=url.searchParams.get('code');
  if(!code)return;
  try{
    await request('POST','/api/auth/native/exchange',{code});
    const result=await request<{user?:any}>('GET','/api/auth/me');
    const user=result.data?.user||null;
    if(!user)throw new Error('Google sign-in returned to MaseNet, but the account session could not be loaded. Please try again.');
    nativeAuthResolver?.(user);
    nativeAuthResolver=null;
    nativeAuthRejecter=null;
  }catch(error){
    const failure=error instanceof Error?error:new Error('MaseNet could not finish Google sign-in.');
    nativeAuthRejecter?.(failure);
    nativeAuthResolver=null;
    nativeAuthRejecter=null;
  }
}
if(Capacitor.isNativePlatform()){
  void App.addListener('appUrlOpen',event=>{void completeNativeAuthUrl(event.url)});
  void App.getLaunchUrl().then(result=>{if(result?.url)void completeNativeAuthUrl(result.url)}).catch(()=>{});
}

/** Cookie-backed Google and Telegram authentication. */
export const auth={
 getUser:async()=>{const r=await request<{user?:any}>("GET","/api/auth/me");return r.data?.user||null;},
 signIn:async():Promise<any>=>{
   if(Capacitor.isNativePlatform()){
     if(nativeAuthResolver)throw new Error('A Google sign-in attempt is already open.');
     const result=new Promise<any>((resolve,reject)=>{nativeAuthResolver=resolve;nativeAuthRejecter=reject});
     try{
       await Browser.open({url:new URL('/api/auth/google?native=1',window.location.origin).toString(),presentationStyle:'popover'});
     }catch(error){
       nativeAuthResolver=null;nativeAuthRejecter=null;
       throw error instanceof Error?error:new Error('Could not open secure Google sign-in.');
     }
     return result;
   }
   window.location.assign("/api/auth/google");
   return await new Promise<any>(()=>{});
 },
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