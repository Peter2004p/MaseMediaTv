import { json, requireOwner, type Env as AuthEnv } from "../auth/_shared";
interface Env extends AuthEnv {}

export const onRequestGet: PagesFunction<Env> = async ({request,env}) => {
  const gate=await requireOwner(request,env); if(gate.response) return gate.response;
  const rows=await env.DB.prepare(
    "SELECT id,title_id,title,media_kind,release_year,season,episode,episode_title,quality,codec,language,file_name,file_size,status,rights_confirmed,created_at FROM telegram_media_assets ORDER BY created_at DESC LIMIT 300"
  ).all();
  return json({ok:true,assets:rows.results||[]});
};

export const onRequestPost: PagesFunction<Env> = async ({request,env}) => {
  const gate=await requireOwner(request,env); if(gate.response) return gate.response;
  if(request.headers.get("Origin")!==new URL(request.url).origin) return json({ok:false,error:"Same-origin confirmation is required."},403);
  let body:{assetId?:string;assetIds?:string[];titleId?:string;confirmDistributionRights?:boolean};
  try{body=await request.json() as typeof body;}catch{return json({ok:false,error:"Invalid request."},400);}
  const titleId=String(body.titleId||"").trim();
  const ids=[...new Set((Array.isArray(body.assetIds)?body.assetIds:body.assetId?[body.assetId]:[]).map(x=>String(x||"").trim()))];
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(titleId)||!ids.length||ids.length>100||ids.some(id=>!/^[0-9a-f-]{36}$/i.test(id))) return json({ok:false,error:"Select a valid title and between 1 and 100 media files."},400);
  if(body.confirmDistributionRights!==true) return json({ok:false,error:"Explicit distribution-rights confirmation is required before publishing."},400);
  const title=await env.DB.prepare("SELECT id,name,kind,metadata_json FROM titles WHERE id=?").bind(titleId).first<{id:string;name:string;kind:string;metadata_json:string}>();
  if(!title) return json({ok:false,error:"The selected catalogue title was not found."},404);
  const placeholders=ids.map(()=>"?").join(",");
  const selected=await env.DB.prepare(
    "SELECT id,title_id,media_kind,title,season,episode,episode_title,quality,file_name,status FROM telegram_media_assets WHERE id IN ("+placeholders+")"
  ).bind(...ids).all<{id:string;title_id:string|null;media_kind:string;title:string;season:number;episode:number;episode_title:string|null;quality:string;file_name:string;status:string}>();
  const assets=selected.results||[];
  if(assets.length!==ids.length) return json({ok:false,error:"One or more selected files could not be found. Refresh the vault and try again."},404);
  const expectedKind=String(title.kind||"").toLowerCase()==="drama"?"drama":"movie";
  if(assets.some(asset=>asset.media_kind!==expectedKind)) return json({ok:false,error:"The selected files do not all match the chosen movie/drama type. Select files of one type and try again."},400);
  if(assets.some(asset=>!["staged","published"].includes(asset.status))) return json({ok:false,error:"One or more selected files are no longer awaiting approval. Refresh the vault."},409);
  if(expectedKind==="drama"&&assets.some(asset=>!Number.isInteger(Number(asset.season))||Number(asset.season)<1||!Number.isInteger(Number(asset.episode))||Number(asset.episode)<1)) return json({ok:false,error:"A selected drama file is missing valid season or episode details. Correct its filename and upload it again."},400);

  let metadata:Record<string,unknown>={};
  try{metadata=JSON.parse(title.metadata_json||"{}") as Record<string,unknown>;}catch{}
  const existingEpisodes=Array.isArray(metadata.episodes)?metadata.episodes as Record<string,unknown>[]:[];
  const nextEpisodes=[...existingEpisodes];
  for(const asset of assets){
    const season=expectedKind==="movie"?1:Number(asset.season)||1;
    const episode=expectedKind==="movie"?1:Number(asset.episode)||1;
    const key=season+"|"+episode+"|"+String(asset.quality||"");
    const index=nextEpisodes.findIndex(ep=>(Number(ep.season)||1)+"|"+(Number(ep.episode)||1)+"|"+String(ep.quality||"")==key);
    const entry:Record<string,unknown>={
      id:asset.id,season,episode,
      title:expectedKind==="movie"?"Movie file":String(asset.episode_title||("Episode "+episode)),
      quality:String(asset.quality||"720p"),
      streamUrl:"",downloadUrl:"",
      vaultAssetId:asset.id,fileName:asset.file_name
    };
    if(index>=0) nextEpisodes[index]={...nextEpisodes[index],...entry};
    else nextEpisodes.push(entry);
  }
  nextEpisodes.sort((a,b)=>Number(a.season||1)-Number(b.season||1)||Number(a.episode||1)-Number(b.episode||1)||String(a.quality||"").localeCompare(String(b.quality||"")));
  metadata={...metadata,id:title.id,name:title.name,type:expectedKind==="drama"?"Drama":"Movie",episodes:nextEpisodes};
  const statements=[
    env.DB.prepare("UPDATE titles SET metadata_json=?,updated_at=datetime('now') WHERE id=?").bind(JSON.stringify(metadata),title.id),
    ...assets.map(asset=>env.DB.prepare("UPDATE telegram_media_assets SET title_id=?,status='published',rights_confirmed=1,updated_at=datetime('now') WHERE id=? AND status IN ('staged','published')").bind(title.id,asset.id))
  ];
  await env.DB.batch(statements);
  return json({ok:true,published:true,publishedCount:assets.length,assetIds:ids,titleId,titleName:title.name});
};
