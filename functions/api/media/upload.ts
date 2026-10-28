import { json, requireAdmin } from "../auth/_shared";
interface Env { DB: D1Database; ADMIN_EMAIL?: string; MEDIA_BUCKET?: R2Bucket; }
const safeName = (s:string) => s.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(-120) || "media.bin";
const jsonImageTypes = ["image/jpeg","image/png","image/webp"];
const subtitleTypes = ["text/vtt","text/plain","application/x-subrip","application/octet-stream"];
const videoTypes = ["video/mp4","video/webm","video/quicktime","video/x-matroska","application/octet-stream"];
const error = (message:string,status:number) => json({error:message},status);

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
 const auth = await requireAdmin(request,env); if(auth.response) return auth.response;
 if(!env.MEDIA_BUCKET) return error("Cloudflare R2 storage is not enabled or its MEDIA_BUCKET binding is missing. No file was uploaded.",503);
 const requestType = request.headers.get("content-type") || "";

 // Multipart uploads are used for actual subtitle/video files so they are not expanded
 // into oversized base64 JSON payloads. Keep a conservative cap for Pages Function memory.
 if(requestType.toLowerCase().includes("multipart/form-data")) {
  let form: FormData;
  try { form = await request.formData(); } catch { return error("Could not read the uploaded file. Please try again.",400); }
  const file = form.get("file");
  const filename = String(form.get("filename") || (file instanceof File ? file.name : "")).trim();
  const folder = String(form.get("folder") || "media").trim().toLowerCase();
  const declaredType = String(form.get("contentType") || (file instanceof File ? file.type : "") || "application/octet-stream").toLowerCase().slice(0,120);
  if(!(file instanceof File) || !filename || file.size === 0) return error("Choose a non-empty file to upload.",400);
  if(auth.admin?.role === "bulk" && (folder !== "posters" || !declaredType.startsWith("image/"))) return error("Restricted admins can upload poster images only.",403);

  const lowerName = filename.toLowerCase();
  let type = declaredType;
  let maxBytes = 0;
  let pathPrefix = folder;
  if(folder === "posters") {
   if(!jsonImageTypes.includes(type)) return error("Poster images must be JPEG, PNG, or WebP.",415);
   maxBytes = 400_000;
   pathPrefix = "posters";
  } else if(folder === "subtitles") {
   if(!(/\.(vtt|srt)$/i.test(lowerName)) || !subtitleTypes.includes(type)) return error("Subtitle files must be WebVTT (.vtt) or SubRip (.srt).",415);
   maxBytes = 2 * 1024 * 1024;
   pathPrefix = "subtitles";
   if(lowerName.endsWith(".vtt")) type = "text/vtt";
   else type = "application/x-subrip";
  } else if(folder === "videos" || folder === "media") {
   const extensionAllowed = /\.(mp4|m4v|webm|mov|mkv)$/i.test(lowerName);
   if(!extensionAllowed || !videoTypes.includes(type)) return error("Video files must be MP4, M4V, WebM, MOV, or MKV.",415);
   maxBytes = 50 * 1024 * 1024;
   pathPrefix = folder === "videos" ? "videos" : "media";
   if(type === "application/octet-stream") {
    type = lowerName.endsWith(".mkv") ? "video/x-matroska" : lowerName.endsWith(".webm") ? "video/webm" : lowerName.endsWith(".mov") ? "video/quicktime" : "video/mp4";
   }
  } else {
   return error("Unsupported upload folder. Use posters, subtitles, or videos.",400);
  }
  if(file.size > maxBytes) return error(folder === "subtitles" ? "Subtitle files must be 2MB or smaller." : folder === "posters" ? "Poster images must be compressed below 400KB." : "Video files must be 50MB or smaller here. For larger episodes, paste a direct HTTPS stream URL.",413);
  const path = pathPrefix + "/" + crypto.randomUUID() + "-" + safeName(filename);
  try {
   await env.MEDIA_BUCKET.put(path,file.stream(),{httpMetadata:{contentType:type,cacheControl:"public, max-age=86400"}});
  } catch {
   return error("Cloudflare R2 could not store this file. Check the media storage binding and try again.",502);
  }
  return json({url:new URL("/api/media/file?path="+encodeURIComponent(path),request.url).toString(),path,contentType:type,size:file.size});
 }

 // Legacy JSON route is deliberately limited to small, compressed poster images.
 const body = await request.json().catch(()=>null) as {filename?:string;contentType?:string;base64?:string;folder?:string}|null;
 if(!body?.base64 || !body.filename) return error("filename and base64 image content are required.",400);
 if(auth.admin?.role === "bulk" && (body.folder !== "posters" || !String(body.contentType || "").startsWith("image/"))) return error("Restricted admins can upload poster images only.",403);
 if(body.folder !== "posters") return error("Use a multipart file upload for subtitles and videos.",415);
 if(body.base64.length > 500_000) return error("Poster is too large after compression. Choose a smaller image.",413);
 const type = String(body.contentType || "").slice(0,120).toLowerCase();
 if(!jsonImageTypes.includes(type)) return error("Only JPEG, PNG, or WebP poster images are allowed.",415);
 let binary: Uint8Array;
 try { const raw=atob(body.base64); binary=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) binary[i]=raw.charCodeAt(i); } catch { return error("Invalid image data.",400); }
 if(binary.length > 400_000) return error("Poster is too large after compression. Choose a smaller image.",413);
 const path="posters/"+crypto.randomUUID()+"-"+safeName(String(body.filename));
 try { await env.MEDIA_BUCKET.put(path,binary,{httpMetadata:{contentType:type,cacheControl:"public, max-age=86400"}}); }
 catch { return error("Cloudflare R2 could not store this poster. Check the media storage binding and try again.",502); }
 return json({url:new URL("/api/media/file?path="+encodeURIComponent(path),request.url).toString(),path,contentType:type,size:binary.length});
};
