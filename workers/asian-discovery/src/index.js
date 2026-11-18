const langMap = [
  ["korean","Korean","South Korea"],["chinese","Chinese","China"],["japanese","Japanese","Japan"],
  ["thai","Thai","Thailand"],["vietnamese","Vietnamese","Vietnam"],["indonesian","Indonesian","Indonesia"],
  ["malay","Malay","Malaysia"],["filipino","Filipino","Philippines"],["tagalog","Filipino","Philippines"],
  ["hindi","Hindi","India"],["bengali","Bengali","Bangladesh"],["tamil","Tamil","India"],["urdu","Urdu","Pakistan"]
];
const uid=()=>crypto.randomUUID();
const durationSeconds=v=>{if(typeof v==="number")return v;const s=str(v);if(!s)return 0;const parts=s.split(":").map(Number);if(parts.some(n=>!Number.isFinite(n)))return 0;if(parts.length===3)return parts[0]*3600+parts[1]*60+parts[2];if(parts.length===2)return parts[0]*60+parts[1];return Number(s)||0;};
const str=v=>typeof v==="string"?v.trim():"";
const inferLang=v=>{const s=(Array.isArray(v)?v.join(" "):String(v||"")).toLowerCase();const m=langMap.find(x=>s.includes(x[0]));return m?{language:m[1],country:m[2]}:{language:"",country:""};};
function licence(name,url,terms){
 const label=str(name),rawUrl=str(url),extra=str(terms);
 let parsed;
 try{parsed=new URL(rawUrl);}catch{return{ok:false,name:label,url:rawUrl,credit:"",reason:"No canonical Creative Commons licence URL"};}
 if(parsed.protocol!=="https:"||parsed.hostname!=="creativecommons.org")return{ok:false,name:label,url:rawUrl,credit:"",reason:"Licence URL is not an official HTTPS Creative Commons URL"};
 const path=parsed.pathname.toLowerCase().replace(/\\/$/,"");
 if(/^\\/licenses\\/(by|by-sa)\\/(2\\.0|3\\.0|4\\.0)$/.test(path)){
  const type=path.includes("by-sa")?"CC BY-SA":"CC BY";
  if(/non.?commercial|no.?derivatives/i.test(label+" "+extra))return{ok:false,name:label,url:rawUrl,credit:"",reason:"Conflicting restricted-rights statement"};
  return{ok:true,name:label||type,url:rawUrl,credit:type==="CC BY-SA"?"Attribution required; ShareAlike terms apply":"Attribution required",reason:type+" official licence URL"};
 }
 if(/^\\/publicdomain\\/(zero|mark)\\/1\\.0$/.test(path))return{ok:true,name:label||"Public Domain / CC0",url:rawUrl,credit:"",reason:"Official Creative Commons public-domain URL"};
 return{ok:false,name:label,url:rawUrl,credit:"",reason:"Licence version or terms not in the auto-publish allowlist"};
}
async function testVideo(url){
 try{const r=await fetch(url,{method:"HEAD",redirect:"follow",signal:AbortSignal.timeout(9000)});if(!r.ok)return null;const mime=(r.headers.get("content-type")||"").split(";")[0].toLowerCase();if(!["video/mp4","video/webm","video/ogg"].includes(mime))return null;const size=Number(r.headers.get("content-length")||0);if(size&&size<250000)return null;return{url,mime};}catch{return null;}
}
async function save(env,item){
 const exists=await env.DB.prepare("SELECT id FROM asian_discovery_items WHERE source=? AND source_id=?").bind(item.source,item.sourceId).first();if(exists)return"seen";
 const video=item.rights.ok&&item.videoUrl?await testVideo(item.videoUrl):null;
 const duration=Number(item.durationSeconds||0);
 const hasAttribution=Boolean(item.creator||item.meta?.artist||item.meta?.credit);\n const status=!item.rights.ok||!video||duration<1200||(item.rights.credit&&!hasAttribution)?"needs_review":"eligible";
 const rowId=uid();
 await env.DB.prepare(`INSERT OR IGNORE INTO asian_discovery_items
 (id,source,source_id,canonical_url,title,year,language,country,licence_name,licence_url,attribution,video_url,mime_type,poster_url,status,metadata_json)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
 rowId,item.source,item.sourceId,item.canonicalUrl,item.title,item.year||null,item.language||"",item.country||"",
 item.rights.name,item.rights.url,[item.creator,item.rights.credit,item.sourceCredit].filter(Boolean).join(" — "),
 video?.url||"",video?.mime||"",item.poster||"",status,JSON.stringify({...item.meta,rightsReason:item.rights.reason})
 ).run();
 if(status!=="eligible")return"review";
 const duplicate=await env.DB.prepare("SELECT id FROM titles WHERE kind='movie' AND lower(name)=lower(?) AND (year=? OR year IS NULL) LIMIT 1").bind(item.title,item.year||null).first();
 if(duplicate){await env.DB.prepare("UPDATE asian_discovery_items SET status='duplicate',published_title_id=?,updated_at=datetime('now') WHERE id=?").bind(duplicate.id,rowId).run();return"duplicate";}
 const titleId=uid(),episodeId=uid();
 const metadata={id:titleId,name:item.title,type:"Movie",year:item.year||null,description:item.description||"",posterUrl:item.poster||"",country:item.country||"",language:item.language||"",source:item.sourceName,sourceIdentifier:item.sourceId,licenseName:item.rights.name,licenseUrl:item.rights.url,attribution:[item.creator,item.rights.credit,item.sourceCredit].filter(Boolean).join(" — "),episodes:[{id:episodeId,season:1,episode:1,title:"Full Movie",streamUrl:video.url,mimeType:video.mime,quality:"Unknown",codec:"Unknown",qualities:[]}]};
 await env.DB.prepare("INSERT INTO titles (id,name,description,poster_url,year,kind,quality,stream_url,metadata_json) VALUES (?,?,?,?,?,'movie','Unknown',?,?)").bind(titleId,item.title,(item.description||"").slice(0,4000),item.poster||"",item.year||null,video.url,JSON.stringify(metadata)).run();
 await env.DB.prepare("UPDATE asian_discovery_items SET status='published',published_title_id=?,updated_at=datetime('now') WHERE id=?").bind(titleId,rowId).run();
 return"published";
}
async function archive(env){
 const q='mediatype:movies AND (language:Korean OR language:Chinese OR language:Japanese OR language:Thai OR language:Vietnamese OR language:Indonesian OR language:Hindi OR language:Bengali OR language:Tamil)';
 const p=new URLSearchParams({q,rows:"6",page:"1",output:"json"});["identifier","title","year","language","creator","description"].forEach(x=>p.append("fl[]",x));
 const r=await fetch("https://archive.org/advancedsearch.php?"+p,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error("Internet Archive search "+r.status);
 const data=await r.json();let found=0,published=0,review=0;
 for(const doc of data.response?.docs||[]){
  const identifier=str(doc.identifier);if(!identifier)continue;
  const m=await fetch("https://archive.org/metadata/"+encodeURIComponent(identifier),{signal:AbortSignal.timeout(12000)});if(!m.ok)continue;
  const payload=await m.json(),meta=payload.metadata||{},right=licence(meta.license,meta.licenseurl,meta.rights);
  const lang=inferLang(meta.language||doc.language),files=(payload.files||[]).filter(f=>str(f.name).toLowerCase().endsWith(".mp4")&&Number(f.size||0)>250000);
  const file=files.sort((a,b)=>Number(a.size||0)-Number(b.size||0))[0],fileName=file?str(file.name):"";
  const videoUrl=fileName?"https://archive.org/download/"+encodeURIComponent(identifier)+"/"+fileName.split("/").map(encodeURIComponent).join("/"):"";
  const result=await save(env,{source:"internet_archive",sourceName:"Internet Archive",sourceId:identifier,canonicalUrl:"https://archive.org/details/"+identifier,title:str(meta.title||doc.title)||identifier,year:Number(String(meta.year||doc.year||"").match(/\d{4}/)?.[0])||null,language:lang.language,country:lang.country,creator:str(meta.creator||doc.creator),description:str(meta.description||doc.description),durationSeconds:durationSeconds(meta.runtime||meta.duration),poster:"https://archive.org/services/img/"+encodeURIComponent(identifier),rights:right,videoUrl,sourceCredit:"Internet Archive "+identifier,meta:{creator:str(meta.creator||doc.creator)}});
  if(result!=="seen"){found++;if(result==="published")published++;if(result==="review")review++;}
 }
 return{found,published,review};
}
async function commons(env){
 const terms=["Korean film","Japanese film","Chinese film","Thai film","Vietnamese film"];let found=0,published=0,review=0;
 for(const term of terms){
  const p=new URLSearchParams({action:"query",format:"json",generator:"search",gsrsearch:'filetype:video "'+term+'"',gsrnamespace:"6",gsrlimit:"2",prop:"imageinfo",iiprop:"url|mime|extmetadata"});
  const r=await fetch("https://commons.wikimedia.org/w/api.php?"+p,{headers:{"user-agent":"MaseNet-Asian-Discovery/1.0"},signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error("Wikimedia Commons "+r.status);
  const data=await r.json();
  for(const page of Object.values(data.query?.pages||{})){
   const info=page.imageinfo?.[0];if(!info)continue;const e=info.extmetadata||{},get=k=>str(e[k]?.value),right=licence(get("LicenseShortName"),get("LicenseUrl"),get("UsageTerms"));
   const title=page.title.replace(/^File:/,"").replace(/\.[^.]+$/,""),lang=inferLang(term);
   const result=await save(env,{source:"wikimedia_commons",sourceName:"Wikimedia Commons",sourceId:String(page.pageid),canonicalUrl:"https://commons.wikimedia.org/wiki/"+page.title.replace(/ /g,"_"),title,language:lang.language,country:lang.country,creator:get("Artist"),description:get("ImageDescription"),durationSeconds:durationSeconds(get("Duration")),rights:right,videoUrl:info.url,poster:"",sourceCredit:"Wikimedia Commons",meta:{artist:get("Artist"),credit:get("Credit")}});
   if(result!=="seen"){found++;if(result==="published")published++;if(result==="review")review++;}
  }
 }
 return{found,published,review};
}
async function run(env,source,fn){
 const runId=uid();await env.DB.prepare("INSERT INTO asian_discovery_runs (id,source,status) VALUES (?,?,'running')").bind(runId,source).run();
 try{const r=await fn(env);await env.DB.prepare("UPDATE asian_discovery_runs SET status='success',found_count=?,published_count=?,review_count=?,completed_at=datetime('now') WHERE id=?").bind(r.found,r.published,r.review,runId).run();return{source,...r};}
 catch(e){const msg=e instanceof Error?e.message:String(e);await env.DB.prepare("UPDATE asian_discovery_runs SET status='failed',error=?,completed_at=datetime('now') WHERE id=?").bind(msg.slice(0,900),runId).run();return{source,error:msg};}
}
export default{
 async scheduled(_controller,env,ctx){ctx.waitUntil(Promise.all([run(env,"internet_archive",archive),run(env,"wikimedia_commons",commons)]).then(r=>console.log("Asian discovery",JSON.stringify(r))));},
 async fetch(request,env){const u=new URL(request.url);if(u.pathname==="/health")return Response.json({ok:true,service:"MaseNet Asian Discovery Preview"});if(u.pathname==="/status"){const [runs,counts]=await Promise.all([env.DB.prepare("SELECT * FROM asian_discovery_runs ORDER BY started_at DESC LIMIT 10").all(),env.DB.prepare("SELECT status,COUNT(*) count FROM asian_discovery_items GROUP BY status").all()]);return Response.json({runs:runs.results||[],counts:counts.results||[]});}return new Response("Not found",{status:404});}
};