import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import MaseNetVlcPlayer from './MaseNetVlcPlayer';

type Quality='480p'|'720p'|'1080p';
type Track={label?:string;url:string;path?:string;lang?:string;mimeType?:string};
type Variant={quality:Quality;streamUrl:string;mimeType?:string;subtitleTracks?:Track[]};
type Episode={id:string;title:string;quality:Quality;streamUrl:string;mimeType?:string;subtitleTracks?:Track[];qualities?:Variant[]};
type Props={episode:Episode;onProgress?:(n:number)=>void;onPlaybackPosition?:(n:number)=>void;onPlaybackStarted?:()=>void;onPlaybackEnded?:()=>void;onPlaybackStateChange?:(playing:boolean,time:number)=>void;profileId?:string;playRequest?:number;resumeAtSeconds?:number;autoPlay?:boolean;muted?:boolean;reelMode?:boolean};
const fmt=(n:number)=>Number.isFinite(n)?Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0'):'0:00';
const isMkv=(url:string,mime='')=>/\.mkv(?:$|[?#])/i.test(url)||/matroska|x-matroska/i.test(mime);
const isHls=(url:string,mime='')=>/\.m3u8(?:$|[?#])/i.test(url)||/mpegurl/i.test(mime);
export default function MaseNetPlayerV2({episode,onProgress,onPlaybackPosition,onPlaybackStarted,onPlaybackEnded,onPlaybackStateChange,resumeAtSeconds=0,autoPlay=false,muted=false,reelMode=false}:Props){
 const videoRef=useRef<HTMLVideoElement>(null),hlsRef=useRef<Hls|null>(null),rootRef=useRef<HTMLElement>(null),retryRef=useRef(0),savedRef=useRef(-1);
 const variants=useMemo(()=>episode.qualities?.length?episode.qualities:[{quality:episode.quality,streamUrl:episode.streamUrl,mimeType:episode.mimeType,subtitleTracks:episode.subtitleTracks}],[episode]);
 const [variantIndex,setVariantIndex]=useState(0),[attempt,setAttempt]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(true),[playing,setPlaying]=useState(false),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[subtitleMenu,setSubtitleMenu]=useState(false),[subtitleIndex,setSubtitleIndex]=useState(-1),[speed,setSpeed]=useState(1),[volume,setVolume]=useState(1),[full,setFull]=useState(false);
 const selected=variants[Math.min(variantIndex,variants.length-1)]||variants[0],url=selected?.streamUrl||episode.streamUrl,mime=selected?.mimeType||episode.mimeType||'';
 const mkv=isMkv(url,mime),hls=isHls(url,mime);
 const tracks=(selected?.subtitleTracks||episode.subtitleTracks||[]).filter(t=>/\.vtt(?:$|[?#])/i.test(t.url||t.path||'')).map(t=>({...t,url:t.url||t.path||''}));
 const proxy='/api/media/proxy?episodeId='+encodeURIComponent(episode.id)+'&source='+encodeURIComponent(url);
 useEffect(()=>{setVariantIndex(0);setAttempt(0);retryRef.current=0;setError('');setSubtitleIndex(-1);},[episode.id]);
 useEffect(()=>{
  if(!mkv)return;
  let alive=true;setLoading(true);setError('');
  return()=>{alive=false;};
 },[mkv,episode.id]);
 useEffect(()=>{
  const video=videoRef.current;if(!video||mkv)return;
  let alive=true;setLoading(true);setError('');setPlaying(false);setTime(0);setDuration(0);
  hlsRef.current?.destroy();hlsRef.current=null;
  const source=hls?proxy:url;
  const failover=()=>{if(!alive)return;setLoading(false);if(retryRef.current<1&&!hls){retryRef.current++;setError('The direct source did not load. Retrying through MaseNet secure proxy…');video.src=proxy;video.load();return;}if(variantIndex+1<variants.length){setVariantIndex(i=>i+1);setError('This source failed. Trying the next available quality…');return;}setError('This source could not be played. It may be offline, expired, blocked by its host, or encoded with an unsupported browser codec.');};
  if(hls&&Hls.isSupported()){
   const h=new Hls({enableWorker:true,lowLatencyMode:false,backBufferLength:45,maxBufferLength:30,manifestLoadingTimeOut:20000,levelLoadingTimeOut:20000,fragLoadingTimeOut:30000,manifestLoadingMaxRetry:2,levelLoadingMaxRetry:3,fragLoadingMaxRetry:3});
   hlsRef.current=h;h.loadSource(source);h.attachMedia(video);
   h.on(Hls.Events.MANIFEST_PARSED,()=>{if(alive){setLoading(false);setError('');}});
   h.on(Hls.Events.ERROR,(_e,data)=>{if(!alive||!data.fatal)return;if(data.type===Hls.ErrorTypes.NETWORK_ERROR&&retryRef.current<2){retryRef.current++;setError('Reconnecting to stream ('+retryRef.current+'/2)…');setTimeout(()=>{if(alive)h.startLoad();},1000*retryRef.current);return;}if(data.type===Hls.ErrorTypes.MEDIA_ERROR){h.recoverMediaError();return;}failover();});
  }else if(hls&&video.canPlayType('application/vnd.apple.mpegurl')){video.src=source;video.load();}
  else if(hls){setLoading(false);setError('This browser does not support HLS playback.');}
  else{video.src=url;video.load();}
  const onReady=()=>{if(!alive)return;setLoading(false);setError('');setDuration(Number.isFinite(video.duration)?video.duration:0);if(resumeAtSeconds>0&&video.duration>resumeAtSeconds+5){video.currentTime=resumeAtSeconds;}if(autoPlay)void video.play().catch(()=>{});};
  const onWaiting=()=>{if(alive)setLoading(true);},onPlaying=()=>{if(alive){setLoading(false);setError('');setPlaying(true);onPlaybackStarted?.();}},onPause=()=>{if(alive){setPlaying(false);onPlaybackStateChange?.(false,video.currentTime||0);}},onTime=()=>{if(!alive)return;const t=video.currentTime||0,d=video.duration||0;setTime(t);if(d>0)onProgress?.(Math.round(t/d*100));onPlaybackPosition?.(Math.floor(t));onPlaybackStateChange?.(!video.paused,t);if(Math.floor(t/10)!==savedRef.current){savedRef.current=Math.floor(t/10);}},onEnd=()=>{if(alive){setPlaying(false);onPlaybackEnded?.();onPlaybackPosition?.(0);}},onError=()=>{if(video.error)failover();};
  video.addEventListener('loadedmetadata',onReady);video.addEventListener('canplay',()=>{if(alive)setLoading(false);});video.addEventListener('waiting',onWaiting);video.addEventListener('playing',onPlaying);video.addEventListener('pause',onPause);video.addEventListener('timeupdate',onTime);video.addEventListener('ended',onEnd);video.addEventListener('error',onError);
  return()=>{alive=false;hlsRef.current?.destroy();hlsRef.current=null;video.removeEventListener('loadedmetadata',onReady);video.removeEventListener('waiting',onWaiting);video.removeEventListener('playing',onPlaying);video.removeEventListener('pause',onPause);video.removeEventListener('timeupdate',onTime);video.removeEventListener('ended',onEnd);video.removeEventListener('error',onError);video.pause();video.removeAttribute('src');video.load();};
 },[episode.id,url,proxy,hls,mkv,attempt,variantIndex]);
 const retry=()=>{retryRef.current=0;setError('');setAttempt(x=>x+1);};
 const toggle=()=>{const v=videoRef.current;if(!v)return;if(v.paused)void v.play().catch(()=>setError('Tap Play again to allow playback in this browser.'));else v.pause();};
 const seek=(n:number)=>{const v=videoRef.current;if(v&&Number.isFinite(v.duration))v.currentTime=Math.max(0,Math.min(v.duration,n));};
 const fullscreen=async()=>{const root=rootRef.current as (HTMLElement&{webkitRequestFullscreen?:()=>Promise<void>|void})|null;const v=videoRef.current as (HTMLVideoElement&{webkitEnterFullscreen?:()=>void})|null;if(!root)return;try{if(document.fullscreenElement){await document.exitFullscreen();setFull(false);return;}if(root.requestFullscreen){await root.requestFullscreen();setFull(true);try{await (screen.orientation as any)?.lock?.('landscape');}catch{}}else if(v?.webkitEnterFullscreen){v.webkitEnterFullscreen();setFull(true);}else{root.classList.toggle('mnv2-fallback-full');setFull(x=>!x);}}catch{root.classList.toggle('mnv2-fallback-full');setFull(x=>!x);}};
 if(mkv)return <MaseNetVlcPlayer key={episode.id+url} src={proxy} fallbackSrc={url} alternateSources={variants.filter(v=>v.streamUrl!==url).map(v=>({src:'/api/media/proxy?episodeId='+encodeURIComponent(episode.id)+'&source='+encodeURIComponent(v.streamUrl),fallbackSrc:v.streamUrl}))} title={episode.title} onProgress={onProgress} onPlaybackPosition={onPlaybackPosition} onPlaybackStarted={onPlaybackStarted} onPlaybackEnded={onPlaybackEnded} onPlaybackStateChange={onPlaybackStateChange} resumeAtSeconds={resumeAtSeconds} autoPlay={autoPlay}/>;
 return <section ref={rootRef} className={'mnv2'+(reelMode?' mnv2-reel':'')} aria-label="MaseNet video player">
  <div className="mnv2-screen"><video ref={videoRef} playsInline preload="metadata" muted={muted} onClick={reelMode?toggle:undefined}>{tracks.map((t,i)=><track key={t.url+i} kind="subtitles" src={t.url} srcLang={t.lang||'en'} label={t.label||t.lang||'Subtitle '+(i+1)}/>)}</video>
   {loading&&<div className="mnv2-status">Preparing playback…</div>}
   {error&&<div className="mnv2-error"><b>Playback issue</b><span>{error}</span><button onClick={retry}>Retry</button></div>}
   {!playing&&!loading&&!error&&<button className="mnv2-play" onClick={toggle} aria-label="Play">▶</button>}
  </div>
  {!reelMode&&<div className="mnv2-controls"><input className="mnv2-seek" aria-label="Seek video" type="range" min="0" max={duration||0} step=".1" value={Math.min(time,duration||0)} onChange={e=>seek(Number(e.target.value))}/>
   <div className="mnv2-row"><button onClick={toggle}>{playing?'Ⅱ':'▶'}</button><button onClick={()=>seek(time-10)}>−10s</button><button onClick={()=>seek(time+10)}>+10s</button><span>{fmt(time)} / {fmt(duration)}</span><button onClick={()=>setSubtitleMenu(x=>!x)}>CC</button><button onClick={fullscreen}>⛶</button></div>
   {subtitleMenu&&<div className="mnv2-submenu"><button onClick={()=>{setSubtitleIndex(-1);const v=videoRef.current;if(v)Array.from(v.textTracks).forEach(t=>t.mode='disabled');}}>Subtitles Off</button>{tracks.map((t,i)=><button key={t.url+i} onClick={()=>{setSubtitleIndex(i);const v=videoRef.current;if(v)Array.from(v.textTracks).forEach((track,j)=>track.mode=j===i?'showing':'disabled');}}>{t.label||t.lang||'Subtitle '+(i+1)}</button>)}{!tracks.length&&<small>No external WebVTT subtitles supplied for this source.</small>}</div>}
   <div className="mnv2-row mnv2-settings"><label>Speed <select value={speed} onChange={e=>{const n=Number(e.target.value);setSpeed(n);if(videoRef.current)videoRef.current.playbackRate=n;}}>{[.5,.75,1,1.25,1.5,2].map(n=><option key={n} value={n}>{n}×</option>)}</select></label><label>Volume <input type="range" min="0" max="1" step=".05" value={volume} onChange={e=>{setVolume(Number(e.target.value));if(videoRef.current)videoRef.current.volume=Number(e.target.value);}}/></label></div>
  </div>}
  <style>{`.mnv2{width:100%;background:#050609;color:#fff;border:1px solid #ffffff20;border-radius:18px;overflow:hidden;position:relative}.mnv2-screen{position:relative;width:100%;aspect-ratio:16/9;min-height:190px;background:#000;display:grid;place-items:center}.mnv2-screen video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}.mnv2-status,.mnv2-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:20px;text-align:center;background:#050609dc;font-size:13px}.mnv2-error span{max-width:520px;line-height:1.5;color:#f1c7c0}.mnv2 button{border:1px solid #ffffff25;border-radius:10px;background:#ffffff10;color:#fff;padding:9px 12px;min-height:38px}.mnv2-error button,.mnv2-play{background:#e6c579;color:#17130b;border:0;font-weight:800}.mnv2-play{position:absolute;border-radius:50%!important;width:68px;height:68px;font-size:23px}.mnv2-controls{padding:11px;background:linear-gradient(#171922,#07080c)}.mnv2-seek{width:100%;accent-color:#e6c579}.mnv2-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.mnv2-row span{margin-right:auto;font-variant-numeric:tabular-nums;font-size:12px;color:#c7c9d1}.mnv2-settings{justify-content:space-between;margin-top:8px;font-size:12px}.mnv2-settings label{display:flex;align-items:center;gap:7px}.mnv2 select{background:#181b24;color:#fff;border:1px solid #ffffff25;border-radius:8px;padding:7px}.mnv2-settings input{width:85px;accent-color:#e6c579}.mnv2-submenu{display:flex;flex-direction:column;gap:5px;max-height:35vh;overflow:auto;padding:9px;margin-top:8px;background:#11151f;border:1px solid #ffffff20;border-radius:12px}.mnv2-submenu button{text-align:left}.mnv2-submenu small{color:#c6c9d2;padding:8px}.mnv2:fullscreen,.mnv2.fallback-full{position:fixed;inset:0;z-index:2147483647;width:100vw;height:100dvh;border:0;border-radius:0;display:flex;flex-direction:column;background:#000}.mnv2:fullscreen .mnv2-screen,.mnv2.fallback-full .mnv2-screen{flex:1;min-height:0;aspect-ratio:auto}.mnv2:fullscreen .mnv2-controls,.mnv2.fallback-full .mnv2-controls{flex:none}.mnv2-reel .mnv2-screen{min-height:0;max-height:38dvh}.mnv2-reel .mnv2-controls{display:none}@media(max-width:560px){.mnv2{border-radius:14px}.mnv2-screen{min-height:180px}.mnv2-controls{padding:8px}.mnv2-row{gap:5px}.mnv2 button{padding:7px 9px}.mnv2-settings{justify-content:flex-start;gap:15px}}`}</style>
 </section>;
}
