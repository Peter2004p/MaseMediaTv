import { useEffect, useRef, useState } from "react";

type Track={id:number;language?:string;title?:string;label?:string;codec?:string;forced?:boolean};
type Props={src:string;title?:string;onProgress?:(n:number)=>void;onPlaybackPosition?:(n:number)=>void;onPlaybackStarted?:()=>void;onPlaybackEnded?:()=>void;onPlaybackStateChange?:(playing:boolean,time:number)=>void;resumeAtSeconds?:number;autoPlay?:boolean};
const stamp=(n:number)=>Number.isFinite(n)?Math.floor(n/60)+":"+String(Math.floor(n%60)).padStart(2,"0"):"0:00";

export default function MaseNetVlcPlayer({src,title="MaseNet video",onProgress,onPlaybackPosition,onPlaybackStarted,onPlaybackEnded,onPlaybackStateChange,resumeAtSeconds=0,autoPlay=false}:Props){
 const root=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),overlay=useRef<HTMLDivElement>(null),engine=useRef<any>(null);
 const [status,setStatus]=useState("loading"),[error,setError]=useState(""),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[subs,setSubs]=useState<Track[]>([]),[audios,setAudios]=useState<Track[]>([]),[subId,setSubId]=useState<number|null>(null),[audioId,setAudioId]=useState<number|null>(null),[menu,setMenu]=useState<"sub"|"audio"|"settings"|null>(null),[rate,setRate]=useState(1),[volume,setVolume]=useState(1),[delay,setDelay]=useState(0);
 useEffect(()=>{let live=true,instance:any=null,observer:ResizeObserver|undefined;
  const start=async()=>{try{
   const mod:any=await import("movi-player/player");if(!live||!canvas.current)return;
   const Player=mod.MoviPlayer||mod.default;if(!Player)throw new Error("MaseNet playback engine failed to initialize.");
   instance=new Player({source:{type:"url",url:src},canvas:canvas.current,renderer:"canvas",decoder:"auto"});engine.current=instance;
   if(overlay.current)instance.setSubtitleOverlay?.(overlay.current);
   const sync=(list?:any[])=>{const all=Array.isArray(list)?list:instance.getTracks?.()||[];const s=instance.getSubtitleTracks?.()||all.filter((t:any)=>t.type==="subtitle");const a=instance.getAudioTracks?.()||all.filter((t:any)=>t.type==="audio");if(live){setSubs(s);setAudios(a);}};
   instance.on?.("tracksChange",sync);
   instance.on?.("timeUpdate",(t:number)=>{if(!live)return;const d=instance.getDuration?.()||0;setTime(t);setDuration(d);onPlaybackPosition?.(t);if(d>0)onProgress?.(Math.min(100,t/d*100));onPlaybackStateChange?.(instance.getState?.()==="playing",t);});
   instance.on?.("durationChange",(d:number)=>{if(live)setDuration(d);});
   instance.on?.("stateChange",(s:string)=>{if(!live)return;setStatus(s);if(s==="playing")onPlaybackStarted?.();onPlaybackStateChange?.(s==="playing",instance.getCurrentTime?.()||0);});
   instance.on?.("ended",()=>{if(live){setStatus("ended");onPlaybackEnded?.();}});
   instance.on?.("error",(e:any)=>{if(live){setError(e?.message||"The MKV decoder reported an error.");setStatus("error");}});
   await instance.load();if(!live)return;sync();setDuration(instance.getDuration?.()||0);setStatus("ready");
   if(resumeAtSeconds>0)await instance.seek(Math.min(resumeAtSeconds,Math.max(0,(instance.getDuration?.()||resumeAtSeconds)-1)));
   if(autoPlay){try{await instance.play();}catch{/* user gesture may be required */}}
   if(canvas.current&&typeof ResizeObserver!=="undefined"){observer=new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r)instance?.resizeCanvas?.(Math.round(r.width*devicePixelRatio),Math.round(r.height*devicePixelRatio));});observer.observe(canvas.current);}
  }catch(e:any){if(live){setError(e?.message||"Unable to open this MKV stream.");setStatus("error");}}};
  void start();return()=>{live=false;observer?.disconnect();try{instance?.destroy?.();}catch{}engine.current=null;};
 },[src]);
 const p=()=>engine.current;
 const toggle=async()=>{try{if(p()?.getState?.()==="playing")p().pause();else await p()?.play();}catch(e:any){setError(e?.message||"Tap Play to start playback.");}};
 const seek=(n:number)=>{const d=p()?.getDuration?.()||duration;if(d>0)void p()?.seek(Math.max(0,Math.min(d,n)));};
 const selectSub=async(id:number|null)=>{try{const ok=await p()?.selectSubtitleTrack(id);if(ok!==false||id===null){setSubId(id);setMenu(null);}}catch{setError("Could not enable that embedded subtitle track.");}};
 const selectAudio=(id:number)=>{const ok=p()?.selectAudioTrack?.(id);if(ok!==false){setAudioId(id);setMenu(null);}};
 const delayBy=(n:number)=>{const next=delay+n;setDelay(next);p()?.setSubtitleDelay?.(next);};
 const fullscreen=()=>{const el=root.current as any;if(el?.requestFullscreen)void el.requestFullscreen();else el?.webkitRequestFullscreen?.();};
 return <section ref={root} className="mnvlc" aria-label="MaseNet video player">
  <div className="mnvlcScreen"><canvas ref={canvas}/><div ref={overlay} className="mnvlcSubtitleLayer"/>{status!=="playing"&&!error&&<button className="mnvlcPlay" onClick={()=>void toggle()}>▶</button>}{status==="loading"&&<div className="mnvlcMessage">Opening MKV and reading embedded tracks…</div>}{error&&<div className="mnvlcMessage mnvlcError"><b>Playback error</b><span>{error}</span></div>}</div>
  <div className="mnvlcControls"><input aria-label="Seek" type="range" min="0" max={Math.max(1,duration)} step=".1" value={Math.min(time,duration||0)} onChange={e=>seek(Number(e.target.value))}/>
   <div className="mnvlcRow"><button onClick={()=>void toggle()}>{status==="playing"?"Ⅱ":"▶"}</button><button onClick={()=>seek(time-10)}>−10s</button><button onClick={()=>seek(time+10)}>+10s</button><span>{stamp(time)} / {stamp(duration)}</span><button onClick={()=>setMenu(menu==="sub"?null:"sub")}>CC {subs.length}</button><button onClick={()=>setMenu(menu==="audio"?null:"audio")}>Audio {audios.length}</button><button onClick={()=>setMenu(menu==="settings"?null:"settings")}>⚙</button><button onClick={fullscreen}>⛶</button></div>
   {menu==="sub"&&<div className="mnvlcMenu"><b>Embedded subtitles</b><button onClick={()=>void selectSub(null)}>Off</button>{subs.map((t,i)=><button key={t.id??i} onClick={()=>void selectSub(t.id)}>{t.title||t.label||t.language||"Subtitle "+(i+1)}{t.codec?" · "+t.codec:""}{t.forced?" · Forced":""}</button>)}{!subs.length&&<small>No subtitle tracks reported by the MKV demuxer.</small>}<div className="mnvlcRow"><button onClick={()=>delayBy(-.5)}>−0.5s</button><button onClick={()=>delayBy(.5)}>+0.5s</button><small>Delay {delay.toFixed(1)}s</small></div></div>}
   {menu==="audio"&&<div className="mnvlcMenu"><b>Audio tracks</b>{audios.map((t,i)=><button key={t.id??i} onClick={()=>selectAudio(t.id)}>{t.title||t.label||t.language||"Audio "+(i+1)}{t.codec?" · "+t.codec:""}</button>)}{!audios.length&&<small>No audio tracks reported.</small>}</div>}
   {menu==="settings"&&<div className="mnvlcMenu"><b>Playback settings</b><label>Speed <select value={rate} onChange={e=>{const n=Number(e.target.value);setRate(n);p()?.setPlaybackRate?.(n);}}>{[.5,.75,1,1.25,1.5,2].map(n=><option value={n}>{n}×</option>)}</select></label><label>Volume <input type="range" min="0" max="1" step=".05" value={volume} onChange={e=>{const n=Number(e.target.value);setVolume(n);p()?.setVolume?.(n);}}/></label></div>}
  </div>
  <style>{`.mnvlc{width:100%;background:#07090e;color:#fff;border:1px solid #ffffff25;border-radius:17px;overflow:hidden}.mnvlcScreen{position:relative;width:100%;aspect-ratio:16/9;min-height:190px;background:#000;display:grid;place-items:center}.mnvlcScreen canvas{width:100%;height:100%;display:block}.mnvlcSubtitleLayer{position:absolute;inset:0;pointer-events:none;display:flex;align-items:flex-end;justify-content:center;text-align:center;padding:0 5% 8%;color:white;text-shadow:0 2px 5px #000,0 0 8px #000;font-size:clamp(16px,2.5vw,28px)}.mnvlcPlay{position:absolute;border:1px solid #fff9;border-radius:50%;width:64px;height:64px;background:#e2c47d;color:#17130a;font-size:23px}.mnvlcMessage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:#050609d9;text-align:center;padding:20px;font-size:13px}.mnvlcError{z-index:3;color:#ffd3cb}.mnvlcControls{position:relative;padding:10px;background:linear-gradient(#171922,#08090d)}.mnvlcControls>input{width:100%;accent-color:#e2c47d}.mnvlcRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.mnvlcRow>span{font-size:12px;font-variant-numeric:tabular-nums;margin-right:auto}.mnvlc button{background:#ffffff10;border:1px solid #ffffff24;border-radius:9px;color:#fff;padding:7px 9px}.mnvlcMenu{position:absolute;z-index:8;right:8px;bottom:calc(100% + 6px);width:min(290px,86vw);max-height:45vh;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid #ffffff30;border-radius:13px;background:#11151ff5;box-shadow:0 12px 40px #000b}.mnvlcMenu b,.mnvlcMenu small{font-size:12px;padding:3px}.mnvlcMenu button{text-align:left}.mnvlcMenu label{display:flex;justify-content:space-between;gap:10px;font-size:12px}.mnvlcMenu select{background:#171b25;color:#fff;border:1px solid #ffffff30;border-radius:7px}.mnvlcMenu input{max-width:120px}.mnvlcMenu .mnvlcRow{padding-top:5px}@media(max-width:520px){.mnvlcRow{gap:4px}.mnvlcRow button{font-size:11px;padding:7px}.mnvlcScreen{min-height:180px}}`}</style>
 </section>;
}
