import { json } from "../auth/_shared";
interface Env { DB: D1Database; }
type EpisodeLike = { id?:string; streamUrl?:string; qualities?:{streamUrl?:string}[] };
const isPublicHttps = (value:string) => {
 try {
  const u=new URL(value);
  const h=u.hostname.toLowerCase().replace(/^\[|\]$/g,"");
  if(u.protocol!=="https:" || u.username || u.password) return false;
  if(h==="localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h==="metadata.google.internal") return false;
  if(/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if(h==="::1" || h==="::" || /^f[cd][0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h) || /^::ffff:(127\.|10\.|192\.168\.|169\.254\.)/i.test(h)) return false;
  return true;
 } catch { return false; }
};
// Follow redirects manually so every destination is revalidated. Automatic redirects can
// bypass the URL checks above if a public media host redirects to a private address.
async function fetchPublicHttps(initialUrl:string, headers:Headers):Promise<Response> {
 let target=initialUrl;
 for(let hop=0;hop<=5;hop++){
  if(!isPublicHttps(target)) throw new Error("Blocked unsafe redirect target");
  const response=await fetch(target,{headers,redirect:"manual"});
  if(![301,302,303,307,308].includes(response.status)) return response;
  const location=response.headers.get("location");
  if(!location){await response.body?.cancel();throw new Error("Redirect missing location");}
  let next:string;
  try{next=new URL(location,target).toString();}catch{await response.body?.cancel();throw new Error("Invalid redirect location");}
  await response.body?.cancel();
  if(hop===5) throw new Error("Too many redirects");
  target=next;
 }
 throw new Error("Too many redirects");
}
export const onRequestGet = async ({ request, env }: { request:Request; env:Env }) => {
 const reqUrl=new URL(request.url), episodeId=reqUrl.searchParams.get("episodeId")||"", requested=reqUrl.searchParams.get("resource");
 if(!episodeId || episodeId.length>200) return json({error:"Missing episodeId"},400);
 const rows=await env.DB.prepare("SELECT metadata_json FROM titles").all<{metadata_json:string}>();
 let episode:EpisodeLike|null=null;
 for(const row of rows.results||[]) {
  try { const title=JSON.parse(row.metadata_json); const found=(title.episodes||[]).find((e:EpisodeLike)=>String(e.id)===episodeId); if(found){episode=found;break;} } catch {}
 }
 if(!episode) return json({error:"Episode not found in the Cloudflare library"},404);
 const allowed=[episode.streamUrl,...(episode.qualities||[]).map(q=>q.streamUrl)].filter((x):x is string=>typeof x==="string" && isPublicHttps(x));
 let upstreamUrl=requested||reqUrl.searchParams.get("source")||allowed[0]||"";
 if(!isPublicHttps(upstreamUrl)) return json({error:"This video source is not an allowed HTTPS URL"},400);
 if(!requested && !allowed.includes(upstreamUrl)) return json({error:"The requested source does not belong to this episode"},403);
 if(requested) {
  // HLS playlists commonly load variants, keys, and media segments from separate
  // CDN hostnames. Permit those playlist-referenced HTTPS resources while still
  // rejecting credentials, local/private literal addresses, and non-HTTPS URLs.
  // The episode must exist in D1 before any resource can be proxied.
  try { const u=new URL(requested); if(!isPublicHttps(u.toString())) return json({error:"Invalid HLS resource URL"},400); }
  catch { return json({error:"Invalid HLS resource URL"},400); }
 }
 const headers=new Headers();
 for(const key of ["range","if-range"]) { const value=request.headers.get(key); if(value) headers.set(key,value); }
 let upstream:Response;
 try { upstream=await fetchPublicHttps(upstreamUrl,headers); } catch { return json({error:"The video source could not be reached safely. Check the media URL and its redirects."},502); }
 if(!upstream.ok && upstream.status!==206) return json({error:"The video source returned HTTP "+upstream.status},502);
 let contentType=upstream.headers.get("content-type")||"";
 let detectedPlaylist=/mpegurl|vnd\.apple\.mpegurl/i.test(contentType)||/\.m3u8(?:$|[?#])/i.test(upstreamUrl)||/\.m3u8(?:$|[?#])/i.test(upstream.url||"");
 // Some streaming providers expose an HLS playlist or MP4 through an extensionless
 // endpoint and label it as application/octet-stream. Peek at a bounded clone of the
 // response so we can identify the container without buffering the actual video.
 if(!detectedPlaylist && !request.headers.has("range") && /^(?:application\/octet-stream|binary\/octet-stream|text\/plain|application\/x-download)(?:\s*;|$)/i.test(contentType) && upstream.body) {
  try {
   const reader=upstream.clone().body?.getReader();
   if(reader) {
    const first=await reader.read();
    const bytes=first.value ? Array.from(first.value.slice(0,4096)) : [];
    await reader.cancel();
    const prefix=new TextDecoder().decode(new Uint8Array(bytes)).replace(/^\\uFEFF/,"").trimStart();
    if(prefix.startsWith("#EXTM3U")) { detectedPlaylist=true; contentType="application/vnd.apple.mpegurl"; }
    else if(bytes.length>=8 && String.fromCharCode(...bytes.slice(4,8))==="ftyp") contentType="video/mp4";
    else if(bytes.length>=4 && bytes[0]===0x1a && bytes[1]===0x45 && bytes[2]===0xdf && bytes[3]===0xa3) contentType="video/x-matroska";
    else if(bytes.length>=4 && bytes[0]===0x47 && bytes[188]===0x47) contentType="video/mp2t";
   }
  } catch { /* Keep the upstream content type if sniffing is unavailable. */ }
 }
 if(detectedPlaylist) {
  // Relative HLS segment URLs must resolve against the final URL after redirects,
  // not the original URL entered by the admin.
  const playlistBase=upstream.url || upstreamUrl;
  const body=await upstream.text();
  const rewritten=body.split(/\r?\n/).map(line=>{
   const trimmed=line.trim();
   if(!trimmed || trimmed.startsWith("#")) {
    return trimmed.replace(/URI="([^"]+)"/g,(_m,uri:string)=>{
     const absolute=new URL(uri,playlistBase).toString();
     return 'URI="'+new URL("/api/media/proxy",reqUrl.origin).toString()+'?episodeId='+encodeURIComponent(episodeId)+'&resource='+encodeURIComponent(absolute)+'"';
    });
   }
   try { const absolute=new URL(trimmed,playlistBase).toString(); return new URL("/api/media/proxy",reqUrl.origin).toString()+"?episodeId="+encodeURIComponent(episodeId)+"&resource="+encodeURIComponent(absolute); } catch { return trimmed; }
  }).join("\n");
  return new Response(rewritten,{status:200,headers:{"content-type":"application/vnd.apple.mpegurl","cache-control":"no-store","access-control-allow-origin":"*","x-content-type-options":"nosniff"}});
 }
 const outHeaders=new Headers();
 for(const key of ["content-length","content-range","accept-ranges","last-modified","etag"]) { const value=upstream.headers.get(key); if(value) outHeaders.set(key,value); } outHeaders.set("content-type",contentType || "application/octet-stream");
 outHeaders.set("cache-control","no-store"); outHeaders.set("access-control-allow-origin","*"); outHeaders.set("x-content-type-options","nosniff");
 return new Response(upstream.body,{status:upstream.status,headers:outHeaders});
};