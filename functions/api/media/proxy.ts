import { json } from "../auth/_shared";
interface Env { DB: D1Database; MEDIA_PROXY_ALLOWED_HOSTS?: string; }
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
// External media providers can reject preview-domain Origin/Referer headers even
// when the same source works from the production domain. Try a clean server-side
// request first, then retry with the existing compatibility headers when needed.
async function fetchMediaSource(url:string, headers:Headers):Promise<Response> {
 const cleanHeaders=new Headers(headers);
 cleanHeaders.delete("origin");
 cleanHeaders.delete("referer");
 const attempts=[cleanHeaders,new Headers(headers)];
 let lastError:unknown=null;
 for(let index=0;index<attempts.length;index++) {
  try {
   const response=await fetchPublicHttps(url,attempts[index]);
   const retryable=response.status===401||response.status===403||response.status===429||response.status>=500;
   if(!retryable||index===attempts.length-1) return response;
   await response.body?.cancel();
  } catch(error) {
   lastError=error;
  }
 }
 throw lastError instanceof Error?lastError:new Error("External media host could not be reached");
}

async function fetchPublicHttps(initialUrl:string, headers:Headers, method:"GET"|"HEAD"="GET"):Promise<Response> {
 let target=initialUrl;
 for(let hop=0;hop<=5;hop++){
  if(!isPublicHttps(target)) throw new Error("Blocked unsafe redirect target");
  const response=await fetch(target,{method,headers,redirect:"manual"});
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
// Resolve HLS child resources against the final playlist URL. Some CDNs sign
// the playlist URL and expect the same authentication query parameters on relative
// segment, variant, subtitle, and key URLs. Preserve child-specific parameters and
// inherit only missing parameters when the child stays on the same HTTPS host.
function resolveHlsResource(raw:string, base:string):string {
 const resolved=new URL(raw.trim(),base);
 const parent=new URL(base);
 if(resolved.protocol==="https:" && parent.protocol==="https:" && resolved.hostname===parent.hostname) {
  parent.searchParams.forEach((value,key)=>{ if(!resolved.searchParams.has(key)) resolved.searchParams.append(key,value); });
 }
 return resolved.toString();
}

function parseContentRangeTotal(value:string|null):number|null {
 if(!value) return null;
 const match=value.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
 if(!match) return null;
 const total=Number(match[1]);
 return Number.isSafeInteger(total)&&total>0?total:null;
}
function parseMatroskaSegmentTotal(bytes:Uint8Array):number|null {
 const id=[0x18,0x53,0x80,0x67];
 for(let i=0;i<=bytes.length-5;i++){
  if(bytes[i]!==id[0]||bytes[i+1]!==id[1]||bytes[i+2]!==id[2]||bytes[i+3]!==id[3]) continue;
  const first=bytes[i+4];
  if(!first) continue;
  let marker=0x80, vintLength=1;
  while(vintLength<=8 && (first&marker)===0){marker>>=1;vintLength++;}
  if(vintLength>8||i+4+vintLength>bytes.length) continue;
  let size=BigInt(first&(marker-1));
  for(let j=1;j<vintLength;j++) size=(size<<8n)|BigInt(bytes[i+4+j]);
  const unknown=(1n<<BigInt(7*vintLength))-1n;
  if(size===unknown) return null;
  const total=BigInt(i+4+vintLength)+size;
  if(total>0n&&total<=BigInt(Number.MAX_SAFE_INTEGER)) return Number(total);
 }
 return null;
}
async function readResponsePrefix(response:Response,limit:number):Promise<Uint8Array> {
 const reader=response.body?.getReader();
 if(!reader) return new Uint8Array();
 const chunks:Uint8Array[]=[];
 let total=0;
 try {
  while(total<limit){
   const part=await reader.read();
   if(part.done) break;
   const chunk=part.value.subarray(0,Math.min(part.value.length,limit-total));
   if(chunk.length){chunks.push(chunk);total+=chunk.length;}
   if(total>=limit) break;
  }
 } finally {
  try{await reader.cancel();}catch{}
 }
 const result=new Uint8Array(total);
 let offset=0;
 for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}
 return result;
}
const matroskaSizeCache=new Map<string,number>();
async function probeMatroskaTotal(url:string,baseHeaders:Headers):Promise<number|null> {
 const cached=matroskaSizeCache.get(url);
 if(cached) return cached;
 try {
  const probeHeaders=new Headers(baseHeaders);
  probeHeaders.set("range","bytes=0-65535");
  probeHeaders.delete("if-range");
  const response=await fetchPublicHttps(url,probeHeaders,"GET");
  let total=parseContentRangeTotal(response.headers.get("content-range"));
  if(!total && response.status===200){
   const length=response.headers.get("content-length")||"";
   if(/^\d+$/.test(length)) total=Number(length);
  }
  if(!total && (response.status===200||response.status===206)){
   const prefix=await readResponsePrefix(response,65536);
   total=parseMatroskaSegmentTotal(prefix);
  } else await response.body?.cancel();
  if(total){
   if(matroskaSizeCache.size>=128) matroskaSizeCache.delete(matroskaSizeCache.keys().next().value as string);
   matroskaSizeCache.set(url,total);
   return total;
  }
 } catch { /* Unknown-size Matroska segments cannot be inferred safely. */ }
 return null;
}

function proxyHlsResource(raw:string, base:string, origin:string, episodeId:string, sourceHint:string):string {
 const value=raw.trim();
 if(!/^https?:\/\//i.test(value) && !value.startsWith("/") && !value.startsWith("./") && !value.startsWith("../") && !value.startsWith("?") && !value.startsWith("#")) {
  try { const parsed=new URL(value); if(parsed.protocol!=="https:" && parsed.protocol!=="http:") return value; } catch {}
 }
 const absolute=resolveHlsResource(value,base);
 if(new URL(absolute).protocol!=="https:") return value;
 // Every nested HLS request must carry the original library source as a lookup hint.
 // Legacy episodes can have synthesized IDs that are not persisted in D1; without this
 // hint, the playlist loads but its child segments are rejected as "Episode not found".
 const nestedEpisodeId=episodeId.length<=200?episodeId:"";
 return origin+"/api/media/proxy?episodeId="+encodeURIComponent(nestedEpisodeId)+"&source="+encodeURIComponent(sourceHint)+"&resource="+encodeURIComponent(absolute);
}
export const onRequestGet = async ({ request, env }: { request:Request; env:Env }) => {
 const reqUrl=new URL(request.url), episodeId=reqUrl.searchParams.get("episodeId")||"", requested=reqUrl.searchParams.get("resource");
 const sourceHint=reqUrl.searchParams.get("source")||"";
 // Legacy upload IDs can embed the complete signed stream URL and exceed 200 chars.
 // When that happens, resolve the episode using the exact stored source URL instead.
 if(episodeId.length>200 && !sourceHint) return json({error:"Invalid episodeId and missing source lookup hint"},400);
 if(!episodeId && !sourceHint) return json({error:"Missing episodeId and source lookup hint"},400);
 const rows=await env.DB.prepare("SELECT metadata_json FROM titles").all<{metadata_json:string}>();
 let episode:EpisodeLike|null=null;
 for(const row of rows.results||[]) {
  try {
   const title=JSON.parse(row.metadata_json);
   const episodes=Array.isArray(title.episodes)?title.episodes as EpisodeLike[]:[];
   // Some legacy public episodes have no stable ID. Resolve them only by an exact
   // stream URL already stored in the library; never accept an arbitrary source URL.
   const found=episodeId && episodeId.length<=200 ? episodes.find((e:EpisodeLike)=>String(e.id)===episodeId) : undefined;
   const bySource=sourceHint
    ? episodes.find((e:EpisodeLike)=>[e.streamUrl,...(e.qualities||[]).map(q=>q.streamUrl)].some((url)=>typeof url==="string" && url===sourceHint))
    : undefined;
   if(found||bySource){episode=found||bySource||null;break;}
  } catch {}
 }
 if(!episode) return json({error:"Episode not found in the Cloudflare library. Check the stored episode ID and source URL."},404);
 const allowed=[episode.streamUrl,...(episode.qualities||[]).map(q=>q.streamUrl)].filter((x):x is string=>typeof x==="string" && isPublicHttps(x));
 let upstreamUrl=requested||reqUrl.searchParams.get("source")||allowed[0]||"";
 if(!isPublicHttps(upstreamUrl)) return json({error:"This video source is not an allowed HTTPS URL"},400);
 if(!requested && !allowed.includes(upstreamUrl)) return json({error:"The requested source does not belong to this episode"},403);
 if(requested) {
  // HLS child URLs are only proxied when their hostname matches the episode's
  // stored source host or an operator-configured CDN hostname. This prevents a
  // valid episode ID being abused as an arbitrary public HTTPS proxy.
  try {
   const child=new URL(requested);
   const sourceHost=new URL(sourceHint || allowed[0] || upstreamUrl).hostname.toLowerCase();
   const configured=(env.MEDIA_PROXY_ALLOWED_HOSTS||"").split(",").map(host=>host.trim().toLowerCase()).filter(Boolean);
   const allowedHosts=new Set([sourceHost,...configured]);
   if(!isPublicHttps(child.toString()) || !allowedHosts.has(child.hostname.toLowerCase()))
    return json({error:"This HLS resource host is not an approved media CDN. Add its hostname to MEDIA_PROXY_ALLOWED_HOSTS if it is a trusted CDN."},403);
  } catch { return json({error:"Invalid HLS resource URL"},400); }
 }
 // Signed CDN URLs commonly carry an Expires Unix timestamp. Detect an
 // expired library URL before proxying it so the player can report the real cause
 // instead of presenting a generic upstream 502.
 const expiryCandidates=[upstreamUrl,sourceHint].filter(Boolean);
 for(const candidate of expiryCandidates) {
  try {
   const expiry=Number(new URL(candidate).searchParams.get("Expires"));
   if(Number.isFinite(expiry) && expiry>0 && Math.floor(Date.now()/1000)>=expiry) {
    return json({error:"This signed video link has expired. Replace it in Admin Library with a fresh streaming URL."},410);
   }
  } catch {}
 }
 const headers=new Headers();
 // Send ordinary browser media headers and identify MaseNet honestly; do not spoof the provider origin.
 headers.set("accept","*/*");
 headers.set("user-agent","Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36");
 headers.set("origin",reqUrl.origin);
 headers.set("referer",reqUrl.origin+"/");
 for(const key of ["range","if-range"]) { const value=request.headers.get(key); if(value) headers.set(key,value); }
 let upstream:Response;
 try { upstream=await fetchMediaSource(upstreamUrl,headers); } catch { return json({error:"The video source could not be reached safely. Check the media URL and its redirects."},502); }
 if(!upstream.ok && upstream.status!==206) {
  if(upstream.status===401 || upstream.status===403) return json({error:"The streaming provider rejected this link (HTTP "+upstream.status+"). It may be expired or its signature may no longer be valid. Replace it with a fresh URL from the provider."},upstream.status);
  if(upstream.status===404 || upstream.status===410) return json({error:"The streaming provider says this video or signed link is no longer available (HTTP "+upstream.status+"). Replace it with a fresh URL."},410);
  return json({error:"The streaming provider returned HTTP "+upstream.status+". The source may be temporarily unavailable."},upstream.status>=400 && upstream.status<500?upstream.status:502);
 }
 let contentType=upstream.headers.get("content-type")||"";
 // Keep the container MIME type when an upstream labels ranged MKV responses as
 // generic binary downloads. The proxy URL itself has no .mkv suffix, so the player
 // otherwise cannot reliably select its Matroska demuxer while requesting byte ranges.
 const mediaPath=(new URL(upstream.url||upstreamUrl)).pathname.toLowerCase();
 const requestedPath=(new URL(upstreamUrl)).pathname.toLowerCase();
 const sourcePath=/\.(mkv|mp4|m4v|webm|mov|m3u8)$/.test(mediaPath)?mediaPath:requestedPath;
 const extensionType=sourcePath.endsWith(".mkv")?"video/x-matroska":sourcePath.endsWith(".mp4")||sourcePath.endsWith(".m4v")?"video/mp4":sourcePath.endsWith(".webm")?"video/webm":sourcePath.endsWith(".mov")?"video/quicktime":sourcePath.endsWith(".m3u8")?"application/vnd.apple.mpegurl":"";
 if(extensionType) contentType=extensionType;
 let detectedPlaylist=/mpegurl|vnd\.apple\.mpegurl/i.test(contentType)||/\.m3u8(?:$|[?#])/i.test(upstreamUrl)||/\.m3u8(?:$|[?#])/i.test(upstream.url||"");
 // Some streaming providers expose an HLS playlist or MP4 through an extensionless
 // endpoint and label it as application/octet-stream. Peek at a bounded clone of the
 // response so we can identify the container without buffering the actual video.
 const rangeHeader=request.headers.get("range")||"";
 const canSniffContainer=!rangeHeader||/^bytes=0-(?:\d*)$/i.test(rangeHeader);
 if(!detectedPlaylist && canSniffContainer && /^(?:application\/octet-stream|binary\/octet-stream|text\/plain|application\/x-download)(?:\s*;|$)/i.test(contentType) && upstream.body) {
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
 // Lightweight format probe for extensionless third-party URLs. It uses the same
 // library allow-list and byte-range proxy as playback, and never stores video bytes.
 if(reqUrl.searchParams.get("probe")==="1") {
  const finalPath=new URL(upstream.url||upstreamUrl).pathname.toLowerCase();
  const isMkv=/matroska|x-matroska/i.test(contentType)||finalPath.endsWith(".mkv");
  const isHls=detectedPlaylist||/mpegurl/i.test(contentType)||finalPath.endsWith(".m3u8");
  const isMp4=/video\/mp4/i.test(contentType)||/\.(mp4|m4v)$/i.test(finalPath);
  const isWebm=/video\/webm/i.test(contentType)||finalPath.endsWith(".webm");
  await upstream.body?.cancel();
  return json({
   kind:isMkv?"mkv":isHls?"hls":isMp4?"mp4":isWebm?"webm":"unknown",
   contentType,
   status:upstream.status,
   supportsRanges:upstream.status===206||/bytes/i.test(upstream.headers.get("accept-ranges")||"")||!!upstream.headers.get("content-range")
  },200);
 }
 if(detectedPlaylist) {
  // Relative HLS segment URLs must resolve against the final URL after redirects,
  // not the original URL entered by the admin.
  const playlistBase=upstream.url || upstreamUrl;
  const body=await upstream.text();
  const rewritten=body.split(/\r?\n/).map(line=>{
   const trimmed=line.trim();
   if(!trimmed) return line;
   if(trimmed.startsWith("#")) {
    return line.replace(/URI=(["'])(.*?)\1/g,(_m,quote:string,uri:string)=>{
     return "URI="+quote+proxyHlsResource(uri,playlistBase,reqUrl.origin,episodeId,sourceHint)+quote;
    });
   }
   try { return proxyHlsResource(trimmed,playlistBase,reqUrl.origin,episodeId,sourceHint); } catch { return line; }
  }).join("\n");
  return new Response(rewritten,{status:200,headers:{"content-type":"application/vnd.apple.mpegurl","cache-control":"no-store","access-control-allow-origin":"*","x-content-type-options":"nosniff"}});
 }
 const outHeaders=new Headers();
 const isMatroska=/matroska|x-matroska/i.test(contentType)||sourcePath.endsWith(".mkv");
 let matroskaTotal:number|null=null;
 if(isMatroska) {
  matroskaTotal=parseContentRangeTotal(upstream.headers.get("content-range"))||matroskaSizeCache.get(upstream.url||upstreamUrl)||null;
  if(!matroskaTotal) matroskaTotal=await probeMatroskaTotal(upstream.url||upstreamUrl,headers);
 }
 for(const key of ["content-length","content-range","accept-ranges","last-modified","etag"]) { const value=upstream.headers.get(key); if(value) outHeaders.set(key,value); }
 // Matroska demuxers need the total resource size for range-based reads.
 // Prefer the exact partial response length when the client requested a range.
 // For a full 200 response, ask HEAD first, then fall back to a one-byte range
 // request because some CDNs reject HEAD but correctly expose Content-Range.
 if(!outHeaders.has("content-length")) {
  const contentRange=upstream.headers.get("content-range")||"";
  const partial=contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if(upstream.status===206 && partial) {
   const rangeLength=Number(partial[2])-Number(partial[1])+1;
   if(Number.isSafeInteger(rangeLength)&&rangeLength>0) outHeaders.set("content-length",String(rangeLength));
  } else if(upstream.status===200) {
   let totalSize="";
   try {
    const head=await fetchPublicHttps(upstream.url||upstreamUrl,headers,"HEAD");
    const size=head.headers.get("content-length");
    if(head.ok && size && /^\d+$/.test(size)) totalSize=size;
    await head.body?.cancel();
   } catch { /* Some media providers do not implement HEAD. */ }
   if(!totalSize) {
    try {
     const rangeHeaders=new Headers(headers);
     rangeHeaders.set("range","bytes=0-0");
     const probe=await fetchPublicHttps(upstream.url||upstreamUrl,rangeHeaders,"GET");
     const probeRange=probe.headers.get("content-range")||"";
     const match=probeRange.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
     const probeLength=probe.headers.get("content-length")||"";
     if(probe.status===206 && match && /^\d+$/.test(match[1])) totalSize=match[1];
     else if(probe.status===200 && /^\d+$/.test(probeLength)) totalSize=probeLength;
     await probe.body?.cancel();
    } catch { /* Continue streaming when the provider exposes no resource size. */ }
   }
   if(totalSize) outHeaders.set("content-length",totalSize);
  }
 }
 if(isMatroska&&matroskaTotal) {
  if(upstream.status===206) {
   const actual=outHeaders.get("content-range")||"";
   const actualParts=actual.match(/^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i);
   const requested=rangeHeader.match(/^bytes=(\d+)-(\d+)$/i);
   const start=actualParts?actualParts[1]:requested?.[1];
   const end=actualParts?actualParts[2]:requested?.[2];
   if(start!==undefined&&end!==undefined) outHeaders.set("content-range","bytes "+start+"-"+end+"/"+matroskaTotal);
  } else if(upstream.status===200&&!outHeaders.has("content-length")) {
   outHeaders.set("content-length",String(matroskaTotal));
  }
 }
 outHeaders.set("content-type",contentType || "application/octet-stream");
 // A download request must remain a streamed response (never buffer the whole movie
 // in the Worker). Content-Disposition tells Android browsers to save the file.
 if(reqUrl.searchParams.get("download")==="1" && !detectedPlaylist) {
  const extension=sourcePath.match(/\.(mkv|mp4|m4v|webm|mov)$/i)?.[1]?.toLowerCase() || "bin";
  outHeaders.set("content-disposition", 'attachment; filename="MaseNet-video.'+extension+'"');
 }
 outHeaders.set("cache-control","no-store"); outHeaders.set("access-control-allow-origin","*"); outHeaders.set("access-control-expose-headers","content-length,content-range,accept-ranges,last-modified,etag"); outHeaders.set("accept-ranges",upstream.headers.get("accept-ranges")||"bytes"); outHeaders.set("x-content-type-options","nosniff");
 return new Response(upstream.body,{status:upstream.status,headers:outHeaders});
};

/**
 * MoviPlayer asks for HEAD before its first byte-range read. Some external MKV
 * providers omit both Content-Length and a numeric Content-Range total. Probe
 * only the first 64 KiB and, when the Matroska Segment declares a finite size,
 * expose that exact size without storing or transcoding the media.
 */
export const onRequestHead = async ({ request, env }: { request:Request; env:Env }) => {
 const headers=new Headers(request.headers);
 headers.set("range","bytes=0-65535");
 headers.delete("if-range");
 const probeRequest=new Request(request.url,{method:"GET",headers});
 const response=await onRequestGet({request:probeRequest,env});
 const outHeaders=new Headers(response.headers);
 let total=parseContentRangeTotal(response.headers.get("content-range"));
 if(!total&&response.status===200){
  const length=response.headers.get("content-length")||"";
  if(/^\d+$/.test(length)) total=Number(length);
 }
 if(!total&&(response.status===200||response.status===206)){
  const prefix=await readResponsePrefix(response,65536);
  total=parseMatroskaSegmentTotal(prefix);
 } else await response.body?.cancel();
 outHeaders.delete("content-range");
 outHeaders.delete("content-length");
 if(total) outHeaders.set("content-length",String(total));
 outHeaders.set("accept-ranges",response.headers.get("accept-ranges")||"bytes");
 return new Response(null,{status:response.status===206?200:response.status,headers:outHeaders});
};
