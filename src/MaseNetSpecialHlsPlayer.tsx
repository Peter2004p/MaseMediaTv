import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

type Props={src:string;title:string;onProgress?:(n:number)=>void;onPlaybackPosition?:(n:number)=>void;onPlaybackStarted?:()=>void;onPlaybackEnded?:()=>void;onPlaybackStateChange?:(playing:boolean,time:number)=>void;resumeAtSeconds?:number;autoPlay?:boolean;playRequest?:number};
const clock=(n:number)=>Number.isFinite(n)?Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0'):'0:00';

/** A fully separate Shaka-first HLS engine for non-standard streaming hosts. */
export default function MaseNetSpecialHlsPlayer({src,title,onProgress,onPlaybackPosition,onPlaybackStarted,onPlaybackEnded,onPlaybackStateChange,resumeAtSeconds=0,autoPlay=false,playRequest=0}:Props){
 const root=useRef<HTMLDivElement>(null),videoRef=useRef<HTMLVideoElement>(null),shakaRef=useRef<any>(null),hlsRef=useRef<Hls|null>(null),restartRef=useRef<()=>void>(()=>{});
 const [engineName,setEngineName]=useState('Special HLS engine'),[status,setStatus]=useState('loading'),[error,setError]=useState(''),[playing,setPlaying]=useState(false);
 const [time,setTime]=useState(0),[duration,setDuration]=useState(0),[volume,setVolume]=useState(1),[muted,setMuted]=useState(false),[speed,setSpeed]=useState(1);
 const [textTracks,setTextTracks]=useState<any[]>([]),[audioTracks,setAudioTracks]=useState<any[]>([]),[menu,setMenu]=useState<'subtitles'|'audio'|'speed'|null>(null),[full,setFull]=useState(false);
 const position=useRef(resumeAtSeconds),attempt=useRef(0),started=useRef(false);
 useEffect(()=>{
  let alive=true,engine:'shaka'|'hls'|null=null,shaka:any=null,hls:Hls|null=null,retryTimer:ReturnType<typeof setTimeout>|null=null,startTimer:ReturnType<typeof setTimeout>|null=null,loadTimer:ReturnType<typeof setTimeout>|null=null,fallbackTimer:ReturnType<typeof setTimeout>|null=null;
  const video=videoRef.current;if(!video)return;
  position.current=resumeAtSeconds;attempt.current=0;started.current=false;
  const clearRetry=()=>{if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}};
  const updateTime=()=>{if(!alive)return;const t=video.currentTime||0,d=Number.isFinite(video.duration)?video.duration:0;setTime(t);setDuration(d);if(t>0)position.current=t;if(d>0)onProgress?.(Math.min(100,Math.round(t/d*100)));onPlaybackPosition?.(Math.floor(t));onPlaybackStateChange?.(!video.paused,t);};
  const onPlaying=()=>{if(!alive)return;clearRetry();setStatus('playing');setPlaying(true);setError('');if(!started.current){started.current=true;onPlaybackStarted?.();}};
  const recover=(reason:string)=>{
   if(!alive)return;
   if(attempt.current>=5){setStatus('error');setError(reason+' The provider is not delivering playable media segments.');return;}
   const delays=[1200,2500,5000,9000,15000],n=++attempt.current;
   setStatus('loading');setError('Stream interrupted. Reconnecting ('+n+'/5)…');clearRetry();
   retryTimer=setTimeout(()=>{retryTimer=null;if(alive)void boot(true);},delays[n-1]);
  };
  const syncTracks=()=>{
   if(!alive)return;
   if(shaka){setTextTracks(shaka.getTextTracks?.()||[]);setAudioTracks(shaka.getAudioTracks?.()||[]);}
   if(hls){setTextTracks(hls.subtitleTracks.map((t:any,i:number)=>({id:i,label:t.name||t.lang||'Subtitle '+(i+1),language:t.lang,engine:'hls'})));setAudioTracks(hls.audioTracks.map((t:any,i:number)=>({id:i,label:t.name||t.lang||'Audio '+(i+1),language:t.lang,engine:'hls'})));}
  };
  const startHlsFallback=async(reason:string)=>{
   if(!alive||engine==='hls')return;
   if(loadTimer){clearTimeout(loadTimer);loadTimer=null;}if(fallbackTimer){clearTimeout(fallbackTimer);fallbackTimer=null;}
   try{await shaka?.destroy?.();}catch{}shaka=null;shakaRef.current=null;
   try{
    if(!Hls.isSupported())throw new Error('This browser does not support the fallback HLS decoder.');
    hls=new Hls({enableWorker:true,enableSoftwareAES:true,lowLatencyMode:false,backBufferLength:60,maxBufferLength:45,maxMaxBufferLength:90,maxBufferHole:1.5,manifestLoadingTimeOut:30000,levelLoadingTimeOut:30000,fragLoadingTimeOut:45000,manifestLoadingMaxRetry:5,levelLoadingMaxRetry:5,fragLoadingMaxRetry:6,manifestLoadingRetryDelay:800,levelLoadingRetryDelay:1000,fragLoadingRetryDelay:1200,startFragPrefetch:true});
    hlsRef.current=hls;engine='hls';setEngineName('Special HLS · hls.js recovery');
    hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(!alive)return;if(fallbackTimer){clearTimeout(fallbackTimer);fallbackTimer=null;}setStatus('ready');setError('');syncTracks();if(position.current>0&&Number.isFinite(video.duration)&&video.duration>position.current+2)video.currentTime=position.current;if(autoPlay)void video.play().catch(()=>{});});
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED,syncTracks);hls.on(Hls.Events.AUDIO_TRACKS_UPDATED,syncTracks);
    hls.on(Hls.Events.ERROR,(_event,data)=>{if(!alive||!data.fatal)return;const httpStatus=Number(data.response?.code||0);const detail=String(data.details||data.type||'network error');if(data.type===Hls.ErrorTypes.NETWORK_ERROR&&attempt.current<4){attempt.current++;setStatus('loading');setError('Reconnecting to the media segments… (attempt '+attempt.current+'/4)');setTimeout(()=>{if(alive)hls?.startLoad();},1000*attempt.current);return;}if(data.type===Hls.ErrorTypes.MEDIA_ERROR){try{hls?.recoverMediaError();return;}catch{}}const responseText=String(data.response?.text||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,180);const failure=reason+' (hls.js '+detail+(httpStatus?' · HTTP '+httpStatus:'')+(responseText?' · '+responseText:'')+').';if(!started.current){setStatus('error');setError(failure+' The provider did not deliver playable media segments.');}else recover(failure);});
    hls.loadSource(src);hls.attachMedia(video);fallbackTimer=setTimeout(()=>{if(alive&&engine==='hls'&&!started.current){setStatus('error');setError('hls.js did not receive a valid media playlist or playable media segment within 45 seconds. '+reason);}},45000);
   }catch(e:any){if(alive){setStatus('error');setError(reason+' '+String(e?.message||e));}}
  };
  const boot=async(fromRecovery=false)=>{
   if(!alive)return;clearRetry();if(loadTimer){clearTimeout(loadTimer);loadTimer=null;}if(fallbackTimer){clearTimeout(fallbackTimer);fallbackTimer=null;}if(startTimer){clearTimeout(startTimer);startTimer=null;}
   try{await shaka?.destroy?.();}catch{}try{hls?.destroy();}catch{}
   shaka=null;hls=null;shakaRef.current=null;hlsRef.current=null;video.pause();video.removeAttribute('src');video.load();
   setStatus('loading');setError('');if(!fromRecovery)setEngineName('Special HLS · Shaka adaptive engine');
   try{
    const imported:any=await import('shaka-player'),Shaka=imported.default||imported;Shaka.polyfill.installAll();
    if(!Shaka.Player.isBrowserSupported())throw new Error('Shaka is not supported in this browser.');
    shaka=new Shaka.Player();shakaRef.current=shaka;engine='shaka';
    shaka.addEventListener('error',(event:any)=>{const d=event.detail||{};if(alive&&engine==='shaka')void startHlsFallback('Shaka could not decode the playlist or a media segment (error '+String(d.code||'unknown')+').');});
    shaka.addEventListener('trackschanged',syncTracks);
    shaka.configure({streaming:{lowLatencyMode:false,bufferingGoal:40,rebufferingGoal:8,bufferBehind:30,retryParameters:{maxAttempts:5,baseDelay:800,backoffFactor:2,fuzzFactor:.3,timeout:30000,stallTimeout:15000,connectionTimeout:15000}},manifest:{retryParameters:{maxAttempts:5,baseDelay:800,backoffFactor:2,timeout:30000}}});
    await shaka.attach(video);await Promise.race([shaka.load(src),new Promise((_,reject)=>{loadTimer=setTimeout(()=>reject(new Error('The playlist or first media segment did not respond within 25 seconds.')),25000);})]);if(loadTimer){clearTimeout(loadTimer);loadTimer=null;}if(!alive)return;
    syncTracks();setEngineName('Special HLS · Shaka');setStatus('ready');setError('');
    if(position.current>0&&Number.isFinite(video.duration)&&video.duration>position.current+2)video.currentTime=position.current;
    if(autoPlay)await video.play().catch(()=>{});
    if(startTimer)clearTimeout(startTimer);startTimer=setTimeout(()=>{if(alive&&!started.current)recover('The playlist loaded but playback produced no frame.');},30000);
   }catch(e:any){if(alive)await startHlsFallback('Shaka could not open this provider stream: '+String(e?.message||e));}
  };
  restartRef.current=()=>{attempt.current=0;started.current=false;position.current=video.currentTime||resumeAtSeconds;void boot();};
  video.addEventListener('playing',onPlaying);video.addEventListener('timeupdate',updateTime);video.addEventListener('durationchange',updateTime);
  video.addEventListener('waiting',()=>{if(alive&&!video.paused){setStatus('loading');setError('Buffering stream segments…');}});
  video.addEventListener('ended',()=>{if(alive){setStatus('ended');setPlaying(false);onPlaybackEnded?.();onPlaybackPosition?.(0);}});
  video.addEventListener('pause',()=>{if(alive){setPlaying(false);onPlaybackStateChange?.(false,video.currentTime||0);}});
  void boot();
  return()=>{alive=false;clearRetry();if(startTimer)clearTimeout(startTimer);if(loadTimer)clearTimeout(loadTimer);if(fallbackTimer)clearTimeout(fallbackTimer);video.removeEventListener('playing',onPlaying);video.removeEventListener('timeupdate',updateTime);video.removeEventListener('durationchange',updateTime);try{hls?.destroy();}catch{}try{void shaka?.destroy?.();}catch{}hlsRef.current=null;shakaRef.current=null;restartRef.current=()=>{};};
 },[src]);
 useEffect(()=>{const v=videoRef.current;if(v&&playRequest>0)void v.play().catch(()=>setError('Tap Play to start the stream.'));},[playRequest]);
 const toggle=()=>{const v=videoRef.current;if(!v)return;if(v.paused)void v.play().catch(()=>setError('Tap Play again to start streaming.'));else v.pause();};
 const seek=(n:number)=>{const v=videoRef.current;if(v&&Number.isFinite(v.duration))v.currentTime=Math.max(0,Math.min(v.duration,n));};
 const selectTrack=(track:any,kind:'subtitles'|'audio')=>{try{if(track.engine==='hls'){if(kind==='subtitles'&&hlsRef.current){hlsRef.current.subtitleDisplay=true;hlsRef.current.subtitleTrack=track.id;}else if(kind==='audio'&&hlsRef.current)hlsRef.current.audioTrack=track.id;}else if(kind==='subtitles'){shakaRef.current?.selectTextTrack?.(track);shakaRef.current?.setTextTrackVisibility?.(true);}else shakaRef.current?.selectAudioTrack?.(track);setMenu(null);}catch{setError('The provider does not expose that track for selection.');}};
 const fullscreen=async()=>{const el=root.current as (HTMLDivElement&{webkitRequestFullscreen?:()=>Promise<void>|void})|null,doc=document as Document&{webkitFullscreenElement?:Element;webkitExitFullscreen?:()=>void};try{if(document.fullscreenElement||doc.webkitFullscreenElement){if(document.exitFullscreen)await document.exitFullscreen();else doc.webkitExitFullscreen?.();setFull(false);return;}const req=el?.requestFullscreen||el?.webkitRequestFullscreen;if(req){await req.call(el);setFull(true);try{await (screen.orientation as any)?.lock?.('landscape');}catch{}}else setFull(true);}catch{setFull(true);}};
 return <section ref={root} className="mnspecial" aria-label={title+' special HLS player'}>
  <div className="mnspecial-head"><i/><div><b>MASENET STREAM CORE</b><small>{engineName}</small></div><span>{status==='playing'?'STREAMING':'HLS'}</span></div>
  <div className="mnspecial-screen"><video ref={videoRef} playsInline preload="auto" onClick={toggle}/>
   {status==='loading'&&<div className="mnspecial-overlay"><i/><b>Establishing stream connection</b><small>{error||'Analysing playlist and preparing media segments…'}</small></div>}
   {status==='error'&&<div className="mnspecial-overlay"><b>Stream connection failed</b><small>{error}</small><button onClick={()=>restartRef.current()}>Retry stream</button></div>}
   {!playing&&status!=='loading'&&status!=='error'&&<button className="mnspecial-play" onClick={toggle}>▶</button>}
  </div>
  <div className="mnspecial-controls"><div className="mnspecial-progress"><span>{clock(time)}</span><input aria-label="Stream position" type="range" min="0" max={Math.max(1,duration)} step=".1" value={Math.min(time,duration||0)} onChange={e=>seek(Number(e.target.value))}/><span>{clock(duration)}</span></div>
   <div className="mnspecial-actions"><button onClick={toggle}>{playing?'Ⅱ':'▶'}</button><button onClick={()=>seek(time-15)}>−15</button><button onClick={()=>seek(time+15)}>+15</button><button onClick={()=>{setMuted(v=>{if(videoRef.current)videoRef.current.muted=!v;return !v;});}}>{muted?'Unmute':'Mute'}</button><label>Vol <input type="range" min="0" max="1" step=".05" value={volume} onChange={e=>{const n=Number(e.target.value);setVolume(n);if(videoRef.current)videoRef.current.volume=n;}}/></label><div className="mnspecial-spacer"/>
    <div className="mnspecial-pop"><button onClick={()=>setMenu(menu==='subtitles'?null:'subtitles')}>CC</button>{menu==='subtitles'&&<div><button onClick={()=>{hlsRef.current&&(hlsRef.current.subtitleTrack=-1);shakaRef.current?.setTextTrackVisibility?.(false);setMenu(null);}}>Off</button>{textTracks.map((t:any,i)=><button key={t.id??i} onClick={()=>selectTrack(t,'subtitles')}>{t.label||t.language||'Subtitle '+(i+1)}</button>)}</div>}</div>
    <div className="mnspecial-pop"><button onClick={()=>setMenu(menu==='audio'?null:'audio')}>Audio</button>{menu==='audio'&&<div>{audioTracks.map((t:any,i)=><button key={t.id??i} onClick={()=>selectTrack(t,'audio')}>{t.label||t.language||'Audio '+(i+1)}</button>)}</div>}</div>
    <div className="mnspecial-pop"><button onClick={()=>setMenu(menu==='speed'?null:'speed')}>{speed}×</button>{menu==='speed'&&<div>{[.5,.75,1,1.25,1.5,2].map(n=><button key={n} onClick={()=>{setSpeed(n);if(videoRef.current)videoRef.current.playbackRate=n;setMenu(null);}}>{n}×</button>)}</div>}</div><button onClick={()=>void fullscreen()}>{full?'Exit':'⛶'}</button>
   </div>
  </div>
  <style>{`.mnspecial{width:100%;background:#070b12;color:#eaf2ff;border:1px solid #35c9d433;border-radius:20px;overflow:visible;box-shadow:0 16px 48px #0008}.mnspecial-head{height:48px;padding:0 14px;display:flex;align-items:center;gap:10px;background:linear-gradient(100deg,#102633,#101827);border-radius:19px 19px 0 0}.mnspecial-head>b,.mnspecial-head div b{display:block;font-size:10px;letter-spacing:1.5px;color:#a9f4ef}.mnspecial-head small{display:block;font-size:10px;color:#91a7b8;margin-top:2px}.mnspecial-head i{width:9px;height:9px;border-radius:50%;background:#39dfbd;box-shadow:0 0 12px #39dfbd}.mnspecial-head>span{margin-left:auto;border:1px solid #43d9c455;border-radius:20px;padding:4px 9px;color:#77e8d7;font-size:9px;letter-spacing:1px}.mnspecial-screen{position:relative;aspect-ratio:16/9;min-height:190px;background:#000;display:grid;place-items:center;overflow:hidden}.mnspecial-screen video{position:absolute;width:100%;height:100%;inset:0;object-fit:contain;background:#000}.mnspecial-overlay{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;text-align:center;padding:24px;background:#050b13e8}.mnspecial-overlay b{font-size:14px}.mnspecial-overlay small{font-size:11px;line-height:1.5;color:#a8bdc9;max-width:520px}.mnspecial-overlay>i{width:27px;height:27px;border:2px solid #ffffff25;border-top-color:#43d9c4;border-radius:50%;animation:mnspecialspin .8s linear infinite}@keyframes mnspecialspin{to{transform:rotate(360deg)}}.mnspecial button{border:1px solid #4ad9c444;background:#132a35;color:#dffefa;border-radius:10px;padding:8px 11px;min-height:34px;font-size:11px;font-weight:700}.mnspecial-play{position:absolute;z-index:3;width:64px;height:64px;border-radius:50%!important;font-size:23px!important;background:#1b9f91!important}.mnspecial-controls{padding:10px 12px 13px;background:linear-gradient(120deg,#0d1822,#101522);border-radius:0 0 19px 19px}.mnspecial-progress{display:flex;align-items:center;gap:9px;font-size:10px;color:#a9bdc9;font-variant-numeric:tabular-nums}.mnspecial-progress input{flex:1;min-width:0;accent-color:#45d6c3}.mnspecial-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}.mnspecial-actions label{display:flex;align-items:center;gap:5px;font-size:10px;color:#a9bdc9}.mnspecial-actions label input{width:64px;accent-color:#45d6c3}.mnspecial-spacer{flex:1}.mnspecial-pop{position:relative}.mnspecial-pop>div{position:absolute;right:0;bottom:calc(100% + 8px);z-index:8;min-width:140px;max-height:40vh;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:8px;background:#111f2b;border:1px solid #45d6c355;border-radius:12px;box-shadow:0 12px 30px #000a}.mnspecial-pop>div button{text-align:left;white-space:nowrap}@media(max-width:560px){.mnspecial{border-radius:15px}.mnspecial-screen{min-height:170px}.mnspecial-controls{padding:8px}.mnspecial-actions{gap:4px}.mnspecial-actions>button{padding:7px 8px}.mnspecial-actions label input{width:48px}.mnspecial-spacer{display:none}}`}</style>
 </section>;
}
