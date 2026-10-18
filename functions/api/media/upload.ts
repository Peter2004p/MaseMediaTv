import { json, requireAdmin } from "../auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; MEDIA_BUCKET?: R2Bucket; }
const safeName = (s:string) => s.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(-120) || "upload.bin";
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
 const auth = await requireAdmin(request,env); if(auth.response) return auth.response;
 if(!env.MEDIA_BUCKET) return json({error:"Cloudflare R2 storage is not enabled or its MEDIA_BUCKET binding is missing. No file was uploaded."},503);
 const body = await request.json().catch(()=>null) as {filename?:string;contentType?:string;base64?:string;folder?:string}|null;
 if(!body?.base64 || !body.filename) return json({error:"filename and base64 file content are required"},400);
 if(body.base64.length > 82_000_000) return json({error:"Upload is too large for this upload route. Use a smaller file."},413);
 const folder = ["posters","media","subtitles","reels"].includes(String(body.folder)) ? String(body.folder) : "media";
 const filename = safeName(String(body.filename));
 const type = String(body.contentType || "application/octet-stream").slice(0,120);
 if(type.startsWith("text/html") || type.includes("javascript")) return json({error:"This file type is not allowed"},415);
 let binary: Uint8Array;
 try { const raw=atob(body.base64); binary=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) binary[i]=raw.charCodeAt(i); } catch { return json({error:"Invalid base64 file data"},400); }
 const path=folder+"/"+crypto.randomUUID()+"-"+filename;
 await env.MEDIA_BUCKET.put(path,binary,{httpMetadata:{contentType:type,cacheControl:"public, max-age=86400"}});
 return json({url:new URL("/api/media/file?path="+encodeURIComponent(path),request.url).toString(),path,contentType:type});
};