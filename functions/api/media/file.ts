interface Env { MEDIA_BUCKET?: R2Bucket; }
export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
 if(!env.MEDIA_BUCKET) return new Response("Media storage is not configured", {status:503});
 const path=new URL(request.url).searchParams.get("path")||"";
 if(!path || path.length>512 || path.startsWith("/") || path.split("/").some(p=>p===".."||p===".")) return new Response("Invalid media path",{status:400});
 const rangeHeader=request.headers.get("range");
 const ifRange=request.headers.get("if-range");
 const meta=await env.MEDIA_BUCKET.head(path);
 if(!meta) return new Response("Media not found",{status:404});
 const etag='"'+meta.httpEtag+'"';
 const headers=new Headers();
 meta.writeHttpMetadata(headers);
 headers.set("etag",etag);
 headers.set("accept-ranges","bytes");
 headers.set("cache-control","public, max-age=86400");
 headers.set("x-content-type-options","nosniff");
 const useRange=!!rangeHeader && (!ifRange || ifRange===etag || ifRange===meta.httpEtag);
 if(useRange) {
  const match=/^bytes=(\\d*)-(\\d*)$/.exec(rangeHeader!.trim());
  if(!match || rangeHeader!.includes(",")) return new Response(null,{status:416,headers:{"content-range":"bytes */"+meta.size,"accept-ranges":"bytes"}});
  const startText=match[1],endText=match[2];
  let start:number,end:number;
  if(!startText && endText) {
   const suffix=Number(endText);
   if(!Number.isSafeInteger(suffix)||suffix<=0) return new Response(null,{status:416,headers:{"content-range":"bytes */"+meta.size,"accept-ranges":"bytes"}});
   start=Math.max(0,meta.size-suffix);end=meta.size-1;
  } else {
   start=Number(startText);end=endText?Number(endText):meta.size-1;
  }
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=meta.size||end<start) return new Response(null,{status:416,headers:{"content-range":"bytes */"+meta.size,"accept-ranges":"bytes"}});
  end=Math.min(end,meta.size-1);
  const ranged=await env.MEDIA_BUCKET.get(path,{range:{offset:start,length:end-start+1}});
  if(!ranged) return new Response("Media not found",{status:404});
  headers.set("content-range","bytes "+start+"-"+end+"/"+meta.size);
  headers.set("content-length",String(end-start+1));
  return new Response(ranged.body,{status:206,headers});
 }
 const object=await env.MEDIA_BUCKET.get(path);
 if(!object) return new Response("Media not found",{status:404});
 headers.set("content-length",String(meta.size));
 return new Response(object.body,{headers});
};
