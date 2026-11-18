export interface Env {
  DB: D1Database;
}

type Rights = { allowed: boolean; name: string; url: string; attribution: string; reason: string };
type Video = { url: string; mime: string; filename: string };
const LANGUAGES: Record<string, { language: string; country: string }> = {
  Korean: { language: "Korean", country: "South Korea" },
  Chinese: { language: "Chinese", country: "China" },
  Japanese: { language: "Japanese", country: "Japan" },
  Thai: { language: "Thai", country: "Thailand" },
  Vietnamese: { language: "Vietnamese", country: "Vietnam" },
  Indonesian: { language: "Indonesian", country: "Indonesia" },
  Malay: { language: "Malay", country: "Malaysia" },
  Filipino: { language: "Filipino", country: "Philippines" },
  Tagalog: { language: "Filipino", country: "Philippines" },
  Hindi: { language: "Hindi", country: "India" },
  Bengali: { language: "Bengali", country: "Bangladesh" },
  Tamil: { language: "Tamil", country: "India" },
  Urdu: { language: "Urdu", country: "Pakistan" },
};
const id = () => crypto.randomUUID();
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const normalize = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const countryFor = (raw: unknown) => {
  const value = Array.isArray(raw) ? raw.join(" ") : String(raw || "");
  for (const [key, item] of Object.entries(LANGUAGES)) {
    if (new RegExp(key, "i").test(value)) return item;
  }
  return { language: "", country: "" };
};
const rightsFrom = (nameRaw: unknown, urlRaw: unknown, statementRaw: unknown): Rights => {
  const name = text(nameRaw);
  const url = text(urlRaw);
  const statement = text(statementRaw);
  const combined = (name + " " + url + " " + statement).toLowerCase();
  if (/non.?commercial|\bcc\s*by.?nc\b|by-nc|no commercial/.test(combined)) {
    return { allowed: false, name, url, attribution: "", reason: "Non-commercial or restricted licence" };
  }
  if (/no.?derivatives|\bcc\s*by.?nd\b|by-nd/.test(combined)) {
    return { allowed: false, name, url, attribution: "", reason: "No-derivatives licence requires legal review" };
  }
  const publicDomain = /public.?domain|creativecommons\.org\/(publicdomain\/(zero|mark))/.test(combined);
  const cc0 = /cc0|creativecommons\.org\/publicdomain\/zero/.test(combined);
  const by = /\bcc\s*by\b|cc-by|creativecommons\.org\/licenses\/by\//.test(combined);
  const bysa = /\bcc\s*by.?sa\b|cc-by-sa|creativecommons\.org\/licenses\/by-sa\//.test(combined);
  if (cc0 || publicDomain) return { allowed: true, name: name || "Public Domain / CC0", url, attribution: "", reason: "Public domain or CC0 declaration" };
  if (bysa) return { allowed: true, name: name || "CC BY-SA", url, attribution: "Attribution required; ShareAlike terms apply", reason: "Creative Commons Attribution-ShareAlike" };
  if (by) return { allowed: true, name: name || "CC BY", url, attribution: "Attribution required", reason: "Creative Commons Attribution" };
  return { allowed: false, name, url, attribution: "", reason: "No clearly reusable licence declaration" };
};
async function headVideo(url: string): Promise<Video | null> {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(9000) });
    if (!response.ok) return null;
    const mime = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const length = Number(response.headers.get("content-length") || 0);
    if (!["video/mp4", "video/webm", "video/ogg"].includes(mime)) return null;
    if (length && length < 250_000) return null;
    return { url, mime, filename: new URL(url).pathname.split("/").pop() || "" };
  } catch { return null; }
}
async function archiveScan(env: Env) {
  const query = 'mediatype:movies AND (language:Korean OR language:Chinese OR language:Japanese OR language:Thai OR language:Vietnamese OR language:Indonesian OR language:Hindi OR language:Bengali OR language:Tamil)';
  const params = new URLSearchParams({ q: query, rows: "18", page: "1", output: "json" });
  for (const field of ["identifier", "title", "year", "language", "creator", "description"]) params.append("fl[]", field);
  const search = await fetch("https://archive.org/advancedsearch.php?" + params.toString(), { headers: { "user-agent": "MaseNet-Asian-Discovery/1.0 (rights-aware archive indexer)" }, signal: AbortSignal.timeout(15000) });
  if (!search.ok) throw new Error("Internet Archive search returned " + search.status);
  const payload = await search.json() as { response?: { docs?: Record<string, unknown>[] } };
  const docs = payload.response?.docs || [];
  let published = 0, review = 0;
  for (const doc of docs) {
    const identifier = text(doc.identifier);
    if (!identifier) continue;
    const exists = await env.DB.prepare("SELECT id FROM asian_discovery_items WHERE source='internet_archive' AND source_id=?").bind(identifier).first();
    if (exists) continue;
    const metaResponse = await fetch("https://archive.org/metadata/" + encodeURIComponent(identifier), { signal: AbortSignal.timeout(12000) });
    if (!metaResponse.ok) continue;
    const metaPayload = await metaResponse.json() as { metadata?: Record<string, unknown>; files?: Record<string, unknown>[] };
    const meta = metaPayload.metadata || {};
    const rights = rightsFrom(meta.licenseurl || meta.license, meta.licenseurl, meta.rights);
    const lang = countryFor(meta.language || doc.language || "");
    const title = text(meta.title || doc.title) || identifier;
    const year = Number(String(meta.year || doc.year || "").match(/\d{4}/)?.[0]) || null;
    const poster = "https://archive.org/services/img/" + encodeURIComponent(identifier);
    const files = (metaPayload.files || []).filter(file => {
      const name = text(file.name).toLowerCase();
      const format = text(file.format).toLowerCase();
      return name.endsWith(".mp4") && (format.includes("mpeg4") || format.includes("mp4") || !format);
    }).sort((a,b)=>Number(a.size||0)-Number(b.size||0));
    const selected = files.find(file => Number(file.size || 0) > 250000) || files[0];
    const fileName = selected ? text(selected.name) : "";
    const fileUrl = fileName ? "https://archive.org/download/" + encodeURIComponent(identifier) + "/" + fileName.split("/").map(encodeURIComponent).join("/") : "";
    const video = rights.allowed && fileUrl ? await headVideo(fileUrl) : null;
    const itemId = id();
    const status = !rights.allowed ? "needs_review" : !video ? "needs_review" : "eligible";
    const attribution = [text(meta.creator || doc.creator), rights.attribution, "Source: Internet Archive (" + identifier + ")"].filter(Boolean).join(" — ");
    await env.DB.prepare(`INSERT OR IGNORE INTO asian_discovery_items
      (id,source,source_id,canonical_url,title,year,language,country,licence_name,licence_url,attribution,video_url,mime_type,poster_url,status,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(itemId,"internet_archive",identifier,"https://archive.org/details/"+encodeURIComponent(identifier),title,year,lang.language,lang.country,rights.name,rights.url,attribution,video?.url||"",video?.mime||"",poster,status,JSON.stringify({ creator:text(meta.creator||doc.creator), description:text(meta.description||doc.description), rightsReason:rights.reason, archiveMetadata:meta })).run();
    if (status === "eligible" && video) {
      const duplicate = await env.DB.prepare("SELECT id FROM titles WHERE kind='movie' AND lower(name)=lower(?) AND (year=? OR year IS NULL) LIMIT 1").bind(title,year).first<{id:string}>();
      if (duplicate) {
        await env.DB.prepare("UPDATE asian_discovery_items SET status='duplicate',published_title_id=?,updated_at=datetime('now') WHERE id=?").bind(duplicate.id,itemId).run();
      } else {
        const titleId=id(), episodeId=id();
        const description = text(meta.description || doc.description).slice(0,4000);
        const metadata = { id:titleId, name:title, type:"Movie", year, description, posterUrl:poster, country:lang.country, language:lang.language, source:"Internet Archive", sourceIdentifier:identifier, licenseName:rights.name, licenseUrl:rights.url, attribution, episodes:[{id:episodeId,season:1,episode:1,title:"Full Movie",streamUrl:video.url,mimeType:video.mime,quality:"Unknown",codec:"Unknown",qualities:[]}] };
        await env.DB.prepare(`INSERT INTO titles (id,name,description,poster_url,year,kind,quality,stream_url,metadata_json)
          VALUES (?,?,?,?,?,'movie','Unknown',?,?)`).bind(titleId,title,description,poster,year,video.url,JSON.stringify(metadata)).run();
        await env.DB.prepare("UPDATE asian_discovery_items SET status='published',published_title_id=?,updated_at=datetime('now') WHERE id=?").bind(titleId,itemId).run();
        published++;
      }
    } else review++;
  }
  return { found: docs.length, published, review };
}
async function commonsScan(env: Env) {
  const terms = ["Korean film","Japanese film","Chinese film","Thai film","Vietnamese film","Asian independent film"];
  let found=0,published=0,review=0;
  for (const term of terms) {
    const params = new URLSearchParams({
      action:"query",format:"json",generator:"search",gsrsearch:'filetype:video "'+term+'"',
      gsrnamespace:"6",gsrlimit:"8",prop:"imageinfo",iiprop:"url|mime|extmetadata"
    });
    const response=await fetch("https://commons.wikimedia.org/w/api.php?"+params.toString(),{headers:{"user-agent":"MaseNet-Asian-Discovery/1.0 (contact: admin@masenet.tv)"},signal:AbortSignal.timeout(12000)});
    if(!response.ok) throw new Error("Wikimedia Commons returned "+response.status);
    const data=await response.json() as {query?:{pages?:Record<string,{pageid:number;title:string;imageinfo?:Array<{url:string;mime:string;extmetadata?:Record<string,{value?:string}>}>}>}};
    for(const page of Object.values(data.query?.pages||{})){
      const sourceId=String(page.pageid);
      const exists=await env.DB.prepare("SELECT id FROM asian_discovery_items WHERE source='wikimedia_commons' AND source_id=?").bind(sourceId).first();
      if(exists) continue;
      found++;
      const info=page.imageinfo?.[0];
      if(!info) continue;
      const ext=info.extmetadata||{};
      const get=(key:string)=>text(ext[key]?.value);
      const rights=rightsFrom(get("LicenseShortName"),get("LicenseUrl"),get("UsageTerms"));
      const video=rights.allowed?await headVideo(info.url):null;
      const fileTitle=page.title.replace(/^File:/,"").replace(/\.[^.]+$/,"");
      const lang=countryFor(term);
      const itemId=id();
      const status=!rights.allowed||!video?"needs_review":"eligible";
      const attribution=[get("Artist"),get("Credit"),rights.attribution,"Source: Wikimedia Commons"].filter(Boolean).join(" — ");
      await env.DB.prepare(`INSERT OR IGNORE INTO asian_discovery_items
        (id,source,source_id,canonical_url,title,language,country,licence_name,licence_url,attribution,video_url,mime_type,status,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(itemId,"wikimedia_commons",sourceId,"https://commons.wikimedia.org/wiki/"+encodeURIComponent(page.title.replace(/ /g,"_")),fileTitle,lang.language,lang.country,rights.name,rights.url,attribution,video?.url||"",video?.mime||"",status,JSON.stringify({rightsReason:rights.reason,description:get("ImageDescription"),artist:get("Artist"),credit:get("Credit")})).run();
      if(status==="eligible"&&video){
        const duplicate=await env.DB.prepare("SELECT id FROM titles WHERE kind='movie' AND lower(name)=lower(?) LIMIT 1").bind(fileTitle).first<{id:string}>();
        if(duplicate){
          await env.DB.prepare("UPDATE asian_discovery_items SET status='duplicate',published_title_id=?,updated_at=datetime('now') WHERE id=?").bind(duplicate.id,itemId).run();
        } else {
          const titleId=id(),episodeId=id();
          const description=get("ImageDescription").slice(0,4000);
          const metadata={id:titleId,name:fileTitle,type:"Movie",description,posterUrl:"",country:lang.country,language:lang.language,source:"Wikimedia Commons",sourceIdentifier:sourceId,licenseName:rights.name,licenseUrl:rights.url,attribution,episodes:[{id:episodeId,season:1,episode:1,title:"Full Movie",streamUrl:video.url,mimeType:video.mime,quality:"Unknown",codec:"Unknown",qualities:[]}]};
          await env.DB.prepare("INSERT INTO titles (id,name,description,year,kind,quality,stream_url,metadata_json) VALUES (?,?,?,NULL,'movie','Unknown',?,?)").bind(titleId,fileTitle,description,video.url,JSON.stringify(metadata)).run();
          await env.DB.prepare("UPDATE asian_discovery_items SET status='published',published_title_id=?,updated_at=datetime('now') WHERE id=?").bind(titleId,itemId).run();
          published++;
        }
      } else review++;
    }
  }
  return {found,published,review};
}
async function run(env:Env, source:string, task:()=>Promise<{found:number;published:number;review:number}>) {
  const runId=id();
  await env.DB.prepare("INSERT INTO asian_discovery_runs (id,source,status) VALUES (?,?,'running')").bind(runId,source).run();
  try {
    const result=await task();
    await env.DB.prepare("UPDATE asian_discovery_runs SET status='success',found_count=?,published_count=?,review_count=?,completed_at=datetime('now') WHERE id=?")
      .bind(result.found,result.published,result.review,runId).run();
    return {source,...result};
  } catch(error) {
    const message=error instanceof Error?error.message:String(error);
    await env.DB.prepare("UPDATE asian_discovery_runs SET status='failed',error=?,completed_at=datetime('now') WHERE id=?").bind(message.slice(0,1000),runId).run();
    return {source,error:message};
  }
}
export default {
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext) {
    ctx.waitUntil((async()=>{
      const results=await Promise.all([
        run(env,"internet_archive",()=>archiveScan(env)),
        run(env,"wikimedia_commons",()=>commonsScan(env))
      ]);
      console.log("MaseNet Asian discovery run",JSON.stringify(results));
    })());
  },
  async fetch(request:Request,env:Env) {
    const url=new URL(request.url);
    if(url.pathname==="/health") return Response.json({ok:true,service:"masenet-asian-discovery",mode:"scheduled",publishing:"only explicit reusable licences"});
    if(url.pathname==="/status"&&request.method==="GET"){
      const [runs,counts]=await Promise.all([
        env.DB.prepare("SELECT source,status,found_count,published_count,review_count,error,started_at,completed_at FROM asian_discovery_runs ORDER BY started_at DESC LIMIT 10").all(),
        env.DB.prepare("SELECT status,COUNT(*) AS count FROM asian_discovery_items GROUP BY status").all()
      ]);
      return Response.json({runs:runs.results||[],counts:counts.results||[]});
    }
    return new Response("Not found",{status:404});
  }
};
