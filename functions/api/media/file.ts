interface Env { MEDIA_BUCKET?: R2Bucket; }
export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
 if(!env.MEDIA_BUCKET) return new Response("Media storage is not configured", {status:503});
 const path=new URL(request.url).searchParams.get("path")||"";
 if(!path || path.length>512 || path.startsWith("/") || path.split("/").some(p=>p===".."||p===".")) return new Response("Invalid media path",{status:400});
 const object=await env.MEDIA_BUCKET.get(path);
 if(!object) return new Response("Media not found",{status:404});
 const headers=new Headers();
 object.writeHttpMetadata(headers);
 headers.set("etag",object.httpEtag);
 headers.set("cache-control","public, max-age=86400");
 headers.set("x-content-type-options","nosniff");
 return new Response(object.body,{headers});
};