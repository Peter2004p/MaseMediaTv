import { json, requireOwner, type Env as AuthEnv } from "../auth/_shared";
interface Env extends AuthEnv {}
export const onRequestGet: PagesFunction<Env> = async ({request,env}) => {
  const gate=await requireOwner(request,env); if(gate.response) return gate.response;
  const rows=await env.DB.prepare(
    "SELECT id,title,media_kind,release_year,season,episode,quality,codec,language,file_name,file_size,status,rights_confirmed,created_at FROM telegram_media_assets ORDER BY created_at DESC LIMIT 200"
  ).all();
  return json({ok:true,assets:rows.results||[]});
};
export const onRequestPost: PagesFunction<Env> = async ({request,env}) => {
  const gate=await requireOwner(request,env); if(gate.response) return gate.response;
  if(request.headers.get("Origin")!==new URL(request.url).origin) return json({ok:false,error:"Same-origin confirmation is required."},403);
  let body:{assetId?:string;titleId?:string;confirmDistributionRights?:boolean};
  try{body=await request.json() as typeof body;}catch{return json({ok:false,error:"Invalid request."},400);}
  const assetId=String(body.assetId||"").trim(),titleId=String(body.titleId||"").trim();
  if(!/^[0-9a-f-]{36}$/i.test(assetId)||!/^[a-zA-Z0-9_-]{1,100}$/.test(titleId)) return json({ok:false,error:"Select a valid media asset and catalogue title."},400);
  if(body.confirmDistributionRights!==true) return json({ok:false,error:"Explicit distribution-rights confirmation is required before publishing."},400);
  const title=await env.DB.prepare("SELECT id FROM titles WHERE id=?").bind(titleId).first<{id:string}>();
  if(!title) return json({ok:false,error:"The selected catalogue title was not found."},404);
  const result=await env.DB.prepare(
    "UPDATE telegram_media_assets SET title_id=?,status='published',rights_confirmed=1,updated_at=datetime('now') WHERE id=? AND status IN ('staged','published')"
  ).bind(titleId,assetId).run();
  if(!Number(result.meta?.changes||0)) return json({ok:false,error:"The media asset could not be published."},404);
  return json({ok:true,published:true,assetId,titleId});
};
