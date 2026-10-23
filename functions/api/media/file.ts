interface Env { MEDIA_BUCKET?: R2Bucket; }
export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
 if(!env.MEDIA_BUCKET) return new Response("Media storage is not configured", {status:503});
 const path=new URL(request.url).searchParams.get("path")||"";
 if(!path || path.length>512 || path.startsWith("/") || path.split("/").some(p=>p===".."||p===".")) return new Response("Invalid media path",{status:400});
 const rangeHeader=request.headers.get("range");
 const ifRange=request.headers.get("if-range");
 let object;
 let range:{offset:number;length:number}|undefined;
 if(rangeHeader && (!ifRange || ifRange.trim()==="")) {
  // Range is parsed after reading metadata so suffix ranges and 416 can be handled accurately.
  object=await env.MEDIA_BUCKET.get(path);
 } else {
  object=await env.MEDIA_BUCKET.get(path);
 }
 if(!object) return new Response("Media not found",{status:404});
 const etag='"'+object.httpEtag+'"';
 const headers=new Headers();
 object.writeHttpMetadata(headers);
 headers.set("etag",etag);
 headers.set("accept-ranges","bytes");
 headers.set("cache-control","public, max-age=86400");
 headers.set("x-content-type-options","nosniff");
 const useRange=!!rangeHeader && (!ifRange || ifRange===etag || ifRange===object.httpEtag);
 if(useRange) {
  const match=/^bytes=(\d*)-(\d*)$/.exec(rangeHeader!.trim());
  if(!match || rangeHeader!.includes(",")) return new Response(null,{status:416,headers:{"content-range":"bytes */"+object.size,"accept-ranges":"bytes"}});
  const startText=match[1],endText=match[2];
  let start:number,end:number;
  if(!startText && endText) {
   const suffix=Number(endText);
   if(!Number.isSafeInteger(suffix)||suffix<=0) return new Response(null,{status:416,headers:{"content-range":"bytes */"+object.size,"accept-ranges":"bytes"}});
   start=Math.max(0,object.size-suffix);end=object.size-1;
  } else {
   start=Number(startText);end=endText?Number(endText):object.size-1;
  }
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=object.size||end<start) return new Response(null,{status:416,headers:{"content-range":"bytes */"+object.size,"accept-ranges":"bytes"}});
  end=Math.min(end,object.size-1);
  range={offset:start,length:end-start+1};
  const ranged=await env.MEDIA_BUCKET.get(path,{range});
  if(!ranged) return new Response("Media not found",{status:404});
  headers.set("content-range","bytes "+start+"-"+end+"/"+object.size);
  headers.set("content-length",String(end-start+1));
  return new Response(ranged.body,{status:206,headers});
 }
 headers.set("content-length",String(object.size));
 return new Response(object.body,{headers});
};
