import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';

const MoviPlayerTag: any = 'movi-player';

type Quality = '480p' | '720p' | '1080p';
type Track = { label?: string; url: string; path?: string; lang?: string; mimeType?: string };
type Variant = { quality: Quality; streamUrl: string; mimeType?: string; subtitleTracks?: Track[] };
type Episode = { id: string; title: string; quality: Quality; streamUrl: string; mimeType?: string; subtitleTracks?: Track[]; qualities?: Variant[] };
type Props = { episode: Episode; onProgress?: (percent: number) => void; onPlaybackPosition?: (seconds: number) => void; onPlaybackStarted?: () => void; onPlaybackEnded?: () => void; onPlaybackStateChange?: (isPlaying:boolean,currentTime:number)=>void; syncCommand?: {revision:number;currentTime:number;isPlaying:boolean}; profileId?: string; playRequest?: number; resumeAtSeconds?: number; autoPlay?: boolean; muted?: boolean; reelMode?: boolean };

const embedFor = (raw: string, autoplay = false) => {
  try {
    const u = new URL(raw); const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return 'https://www.youtube.com/embed/' + u.pathname.slice(1).split('/')[0] + '?rel=0' + (autoplay ? '&autoplay=1&mute=1&playsinline=1' : '');
    if (host.endsWith('youtube.com')) { const id = u.searchParams.get('v') || u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)?.[1]; return id ? 'https://www.youtube.com/embed/' + id + '?rel=0' + (autoplay ? '&autoplay=1&mute=1&playsinline=1' : '') : null; }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') { const id = u.pathname.match(/(?:video\/)?(\d+)/)?.[1]; return id ? 'https://player.vimeo.com/video/' + id : null; }
  } catch { /* invalid URL */ }
  return null;
};
const timeLabel = (value: number) => Number.isFinite(value) ? Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0') : '0:00';
const languageMatch=(available:string|undefined,preferred:string)=>{const a=String(available||'').toLowerCase().replace('_','-');const p=preferred.toLowerCase().replace('_','-');return !!p&&p!=='off'&&p!=='auto'&&(a===p||a.startsWith(p+'-')||p.startsWith(a+'-'));};

export default function FlootPlayer({ episode, onProgress, onPlaybackPosition, onPlaybackStarted, onPlaybackEnded, onPlaybackStateChange, syncCommand, profileId, playRequest = 0, resumeAtSeconds = 0, autoPlay = false, muted = false, reelMode = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null); const mkvPlayerRef = useRef<any>(null); const hlsRef = useRef<Hls | null>(null); const proxiedFallbackRef = useRef(false); const hlsProbeRef = useRef(false); const lastSavedTimeRef = useRef(-1);
  const [quality, setQuality] = useState(''); const [subtitle, setSubtitle] = useState('off'); const [playing, setPlaying] = useState(false); const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState(''); const hlsRecoveryAttemptsRef = useRef({ network: 0, media: 0 }); const [nativeSubtitleTracks, setNativeSubtitleTracks] = useState<{label:string;lang:string}[]>([]); const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false); const [subtitleNotice, setSubtitleNotice] = useState(''); const [hlsSubtitleTracks, setHlsSubtitleTracks] = useState<{name?:string;lang?:string}[]>([]); const [time, setTime] = useState(0); const [duration, setDuration] = useState(0);
  const [preferredSubtitleLanguage,setPreferredSubtitleLanguage]=useState(()=>{try{return localStorage.getItem('masenet-preferred-subtitle-language'+(profileId?'-'+profileId:''))||'off'}catch{return 'off'}}); const [preferredAudioLanguage,setPreferredAudioLanguage]=useState(()=>{try{return localStorage.getItem('masenet-preferred-audio-language'+(profileId?'-'+profileId:''))||'auto'}catch{return 'auto'}}); const [hlsAudioTracks,setHlsAudioTracks]=useState<{name?:string;lang?:string}[]>([]); const preferencesHydrated=useRef(false);
  const [volume, setVolume] = useState(() => { try { const n = Number(localStorage.getItem('masenet-player-volume')); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1; } catch { return 1; } }); const [speed, setSpeed] = useState(() => { try { const n = Number(localStorage.getItem('masenet-player-speed')); return [0.5, 0.75, 1, 1.25, 1.5, 2].includes(n) ? n : 1; } catch { return 1; } }); const [retry, setRetry] = useState(0);
  const [mkvUseDirectSource, setMkvUseDirectSource] = useState(false);
  const hlsAutoSubtitleRef = useRef(false);
  const [moviReady, setMoviReady] = useState(false);
  const variants = useMemo<Variant[]>(() => {
    const values = episode.qualities?.length ? episode.qualities : [{ quality: episode.quality, streamUrl: episode.streamUrl, mimeType: episode.mimeType, subtitleTracks: episode.subtitleTracks }];
    return values.filter((v, i) => !!v.streamUrl && values.findIndex(x => x.quality === v.quality) === i);
  }, [episode]);
  const selected = variants.find(v => v.quality === quality) || variants[0];
  const rawSrc = selected?.streamUrl || episode.streamUrl || ''; 
  const embed = embedFor(rawSrc, autoPlay);
  const tracks = (selected?.subtitleTracks || episode.subtitleTracks || []).filter(t => {
    const value = String(t.url || t.path || '').trim();
    // Browser <track> can load same-origin relative WebVTT URLs as well as absolute HTTP(S) URLs.
    const safeUrl = /^https?:\/\//i.test(value) || (!value.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(value));
    return safeUrl && /\.vtt(?:$|[?#])/i.test(value);
  }).map(t => ({ ...t, url: String(t.url || t.path).trim() }));
  const isHlsSource = /\.m3u8(?:$|[?#])/i.test(rawSrc) || /mpegurl/i.test(selected?.mimeType || episode.mimeType || '');
  const isMkvSource = /\.mkv(?:$|[?#])/i.test(rawSrc) || /matroska|x-matroska/i.test(selected?.mimeType || episode.mimeType || '');
  const vlcIntent = '';
  const telegramWebView = typeof window !== 'undefined' && (/Telegram/i.test(navigator.userAgent) || Boolean((window as Window & { Telegram?: { WebApp?: unknown } }).Telegram?.WebApp));
  const proxyUrl = '/api/media/proxy?episodeId=' + encodeURIComponent(episode.id) + '&source=' + encodeURIComponent(rawSrc);
  const src = isHlsSource ? proxyUrl : rawSrc;
  const mkvProxyUrl = mkvUseDirectSource ? rawSrc : proxyUrl;

  useEffect(() => { setMkvUseDirectSource(false); }, [episode.id, rawSrc]);

  // Load the large Matroska-capable player only when an MKV source is actually opened.
  // This keeps the regular MP4/HLS experience from downloading its multi-megabyte decoder bundle.
  useEffect(() => {
    if (!isMkvSource) { setMoviReady(false); return; }
    let active = true;
    setMoviReady(false);
    import('movi-player/element/slim').then(() => {
      if (active) { setMoviReady(true); setError(''); }
    }).catch(() => {
      if (active) setError('The MKV playback module could not load. Check your connection and tap Retry.');
    });
    return () => { active = false; };
  }, [isMkvSource, retry]);

  useEffect(() => { setQuality(''); setSubtitle('off'); setSubtitleMenuOpen(false); setSubtitleNotice(''); }, [episode.id]);
  // Keep Movi's native subtitle picker untouched. DOM-wide menu styling can
  // interfere with the custom element's own click/touch handling in WebViews.

  useEffect(() => {
    const video = videoRef.current; if (!video) return;
    setError(''); hlsRecoveryAttemptsRef.current = { network: 0, media: 0 }; setHlsSubtitleTracks([]); setNativeSubtitleTracks([]); hlsAutoSubtitleRef.current = false; setBuffering(false); setTime(0); setDuration(0); setPlaying(false); proxiedFallbackRef.current = false; hlsProbeRef.current = false;
    hlsRef.current?.destroy(); hlsRef.current = null;
    if (!src || embed) return;
    if (isHlsSource && Hls.isSupported()) {
      // Prefer Hls.js on Android/Chrome and Telegram WebViews. canPlayType() can
      // return a misleading value on mobile even when native HLS playback fails.
      // Hls.js also gives us consistent playlist/segment loading through our proxy.
      const hls = new Hls({
        enableWorker: true,
        subtitleDisplay: true,
        backBufferLength: 30,
        manifestLoadingTimeOut: 20000,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 3
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
      hls.attachMedia(video);
      const syncHlsSubtitles = () => {
        const available = hls.subtitleTracks.map(t => ({name:t.name,lang:t.lang}));
        setHlsSubtitleTracks(available);
        setHlsAudioTracks(hls.audioTracks.map(t=>({name:t.name,lang:t.lang})));
        // HLS.js discovers subtitle renditions after parsing the master/media playlist.
        // Turn on the first supplied subtitle by default; users can still switch tracks
        // or turn subtitles off from MaseNet's subtitle menu.
        if (available.length && !hlsAutoSubtitleRef.current) {
          hlsAutoSubtitleRef.current = true;
          const preferredIndex=preferredSubtitleLanguage==='off'?-1:available.findIndex(t=>languageMatch(t.lang||t.name,preferredSubtitleLanguage));
          if(preferredIndex>=0){hls.subtitleDisplay=true;hls.subtitleTrack=preferredIndex;setSubtitle('hls-'+preferredIndex);setSubtitleNotice(available[preferredIndex].name||available[preferredIndex].lang||'Preferred subtitles enabled');}
          else if(preferredSubtitleLanguage==='off'){hls.subtitleDisplay=false;hls.subtitleTrack=-1;setSubtitle('off');}
          else {hls.subtitleDisplay=true;hls.subtitleTrack=0;setSubtitle('hls-0');setSubtitleNotice(available[0].name||available[0].lang||'Subtitles enabled');}
        } else if (available.length && subtitle.startsWith('hls-')) {
          hls.subtitleDisplay = true;
          hls.subtitleTrack = Number(subtitle.slice(4));
        }
      };
      hls.on(Hls.Events.MANIFEST_PARSED, () => { setError(''); setBuffering(false); syncHlsSubtitles(); const audio=hls.audioTracks; if(audio.length){const preferred=preferredAudioLanguage==='auto'?-1:audio.findIndex(t=>languageMatch(t.lang||t.name,preferredAudioLanguage));if(preferred>=0)hls.audioTrack=preferred;}});
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, syncHlsSubtitles);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        
        const attempts = hlsRecoveryAttemptsRef.current;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && attempts.network < 2) {
          attempts.network += 1;
          setError('Reconnecting to the stream (' + attempts.network + '/2)…');
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && attempts.media < 1) {
          attempts.media += 1;
          setError('Smart Assist is recovering the video decoder…');
          hls.recoverMediaError();
          return;
        }
        setBuffering(false);
        const status = data.response?.code ? ' (HTTP ' + data.response.code + ')' : '';
        const detail = data.details ? ' [' + data.details + ']' : '';
        setError(data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? 'HLS network error' + status + detail + '. The playlist or a video segment could not be loaded. Check whether the signed link is still valid, then retry.'
          : 'HLS playback or decoding error' + status + detail + '. The stream may use an unsupported codec or malformed playlist.');
        hls.destroy();
        if (hlsRef.current === hls) hlsRef.current = null;
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          setError('Switching to the browser’s native HLS player…');
          setAssistStatus('assisting');
          video.src = src;
          video.load();
          return;
        }
        
      });
    } else if (isHlsSource && video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS is the fallback for Safari/iOS when MediaSource/Hls.js is unavailable.
      video.src = src;
      video.load();
    } else if (isHlsSource) {
      setError('This browser does not support HLS playback. Try a browser-compatible MP4 source.');
      return;
    } else { video.src = src; video.load(); }
    return () => { hlsRef.current?.destroy(); hlsRef.current = null; };
  }, [src, rawSrc, embed, isHlsSource, isMkvSource, telegramWebView, selected?.mimeType, episode.mimeType, retry]);

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const metadata = () => { const d = Number.isFinite(v.duration) ? v.duration : 0; setDuration(d); setNativeSubtitleTracks(Array.from(v.textTracks).map(t=>({label:t.label||t.language||'Subtitle track',lang:t.language||''}))); if (!reelMode && d > 30) { try { const localSaved = Number(localStorage.getItem('masenet-resume-' + episode.id)); const cloudSaved = Number(resumeAtSeconds); const saved = Number.isFinite(cloudSaved) && cloudSaved > 10 ? cloudSaved : localSaved; if (Number.isFinite(saved) && saved > 10 && saved < d - 30) { v.currentTime = saved; lastSavedTimeRef.current = Math.floor(saved / 10); } } catch { /* Resume storage may be unavailable. */ } } }; const tracksChanged = () => setNativeSubtitleTracks(Array.from(v.textTracks).map(t=>({label:t.label||t.language||'Subtitle track',lang:t.language||''})));
    const tick = () => { setTime(v.currentTime || 0); if (v.duration > 0 && Number.isFinite(v.duration)) onProgress?.(Math.round(v.currentTime / v.duration * 100)); if (!reelMode && v.currentTime > 0) { const bucket = Math.floor(v.currentTime / 10); if (bucket !== lastSavedTimeRef.current) { lastSavedTimeRef.current = bucket; onPlaybackPosition?.(Math.floor(v.currentTime)); try { localStorage.setItem('masenet-resume-' + episode.id, String(Math.floor(v.currentTime))); } catch { /* Storage may be unavailable. */ } } } }; const ended = () => { if (!reelMode) { onPlaybackPosition?.(0); onPlaybackEnded?.(); try { localStorage.removeItem('masenet-resume-' + episode.id); } catch { /* Storage may be unavailable. */ } } };
    const play = () => { setPlaying(true); setBuffering(false); setError(''); onPlaybackStarted?.(); onPlaybackStateChange?.(true,v.currentTime||0); }; const pause = () => { setPlaying(false); onPlaybackStateChange?.(false,v.currentTime||0); };
    const wait = () => { setBuffering(true);  }; const ready = () => { setBuffering(false); setError('');  };
    const fail = () => { setBuffering(false); if (!v.error) return; if ([2, 3, 4].includes(v.error.code) && !isHlsSource && !proxiedFallbackRef.current && rawSrc && /^https:\/\//i.test(rawSrc)) { proxiedFallbackRef.current = true; setError('Trying the stream through MaseNet’s secure video proxy…'); v.src = '/api/media/proxy?episodeId=' + encodeURIComponent(episode.id) + '&source=' + encodeURIComponent(rawSrc); v.load(); return; } if (v.error.code === 4 && proxiedFallbackRef.current && !hlsProbeRef.current && Hls.isSupported()) { hlsProbeRef.current = true; setError('Checking whether this endpoint is an HLS stream…'); const hls = new Hls({ enableWorker: true, backBufferLength: 30 }); hlsRef.current?.destroy(); hlsRef.current = hls; hls.loadSource('/api/media/proxy?episodeId=' + encodeURIComponent(episode.id) + '&source=' + encodeURIComponent(rawSrc)); hls.attachMedia(v); hls.on(Hls.Events.MANIFEST_PARSED, () => { setError(''); setBuffering(false); }); hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { hls.destroy(); if (hlsRef.current === hls) hlsRef.current = null; setBuffering(false); setError('This source is not a browser-playable MP4 or HLS stream. If it is MKV or VLC-only, it must be converted to MP4/HLS before MaseNet can play it.'); } }); return; } setError((({2:'Network error loading this video. The source may be offline, expired, or blocking playback.',3:'This browser cannot decode this video or audio codec. The source may use a VLC-supported codec that browsers do not support.',4:'The browser rejected this stream format. MaseNet checked the direct URL and secure proxy, and is checking for an HLS playlist. If it is an MKV/VLC-only source, it needs browser-compatible MP4/HLS conversion.'} as Record<number,string>)[v.error.code] || 'Video playback failed. Check the source URL or retry.')); };
    v.addEventListener('loadedmetadata', metadata); v.addEventListener('ended', ended); v.textTracks.addEventListener('addtrack', tracksChanged); v.textTracks.addEventListener('change', tracksChanged); v.addEventListener('timeupdate', tick); v.addEventListener('play', play); v.addEventListener('pause', pause); v.addEventListener('waiting', wait); v.addEventListener('canplay', ready); v.addEventListener('error', fail);
    return () => { v.removeEventListener('loadedmetadata', metadata); v.removeEventListener('ended', ended); v.textTracks.removeEventListener('addtrack', tracksChanged); v.textTracks.removeEventListener('change', tracksChanged); v.removeEventListener('timeupdate', tick); v.removeEventListener('play', play); v.removeEventListener('pause', pause); v.removeEventListener('waiting', wait); v.removeEventListener('canplay', ready); v.removeEventListener('error', fail); };
  }, [onProgress, onPlaybackPosition, onPlaybackStarted, onPlaybackEnded, onPlaybackStateChange, resumeAtSeconds, isMkvSource, isHlsSource, rawSrc, episode.id, telegramWebView]);

  const profileUnlockHeaders=()=>{try{const token=profileId?sessionStorage.getItem('masenet-profile-unlock-'+profileId):null;return token?{'X-MaseNet-Profile-Unlock':token}:{}}catch{return {}}};
  useEffect(()=>{let active=true;preferencesHydrated.current=false;const headers=profileUnlockHeaders();fetch('/api/user-preferences'+(profileId?'?profileId='+encodeURIComponent(profileId):''),{credentials:'include',headers}).then(async response=>{if(!response.ok)throw new Error(response.status===423?'Unlock this profile to load its player preferences.':'not signed in');const data=await response.json();if(!active)return;const prefs=data?.preferences||{};if(typeof prefs.subtitleLanguage==='string')setPreferredSubtitleLanguage(prefs.subtitleLanguage);if(typeof prefs.audioLanguage==='string')setPreferredAudioLanguage(prefs.audioLanguage);}).catch(()=>{}).finally(()=>{if(active)preferencesHydrated.current=true});return()=>{active=false}},[profileId]);
  useEffect(()=>{if(!preferencesHydrated.current)return;try{localStorage.setItem('masenet-preferred-subtitle-language'+(profileId?'-'+profileId:''),preferredSubtitleLanguage)}catch{};fetch('/api/user-preferences',{method:'POST',credentials:'include',headers:{'content-type':'application/json',...profileUnlockHeaders()},body:JSON.stringify({profileId,subtitleLanguage:preferredSubtitleLanguage,audioLanguage:preferredAudioLanguage})}).catch(()=>{});const v=videoRef.current;if(v){const tracks=Array.from(v.textTracks);if(preferredSubtitleLanguage==='off')tracks.forEach(t=>t.mode='disabled');else{const index=tracks.findIndex(t=>languageMatch(t.language||t.label,preferredSubtitleLanguage));if(index>=0)tracks.forEach((t,i)=>t.mode=i===index?'showing':'disabled');}}},[preferredSubtitleLanguage,nativeSubtitleTracks,profileId]);
  useEffect(()=>{if(!preferencesHydrated.current)return;try{localStorage.setItem('masenet-preferred-audio-language'+(profileId?'-'+profileId:''),preferredAudioLanguage)}catch{};fetch('/api/user-preferences',{method:'POST',credentials:'include',headers:{'content-type':'application/json',...profileUnlockHeaders()},body:JSON.stringify({profileId,subtitleLanguage:preferredSubtitleLanguage,audioLanguage:preferredAudioLanguage})}).catch(()=>{});if(hlsRef.current&&preferredAudioLanguage!=='auto'){const tracks=hlsRef.current.audioTracks;const index=tracks.findIndex(t=>languageMatch(t.lang||t.name,preferredAudioLanguage));if(index>=0)hlsRef.current.audioTrack=index;}},[preferredAudioLanguage,hlsAudioTracks,profileId]);
  useEffect(() => { const v = videoRef.current; if (v) v.volume = volume; try { localStorage.setItem('masenet-player-volume', String(volume)); } catch { /* Storage may be unavailable in private browsing. */ } }, [volume]);
  useEffect(() => { const v = videoRef.current; if (v) v.playbackRate = speed; try { localStorage.setItem('masenet-player-speed', String(speed)); } catch { /* Storage may be unavailable in private browsing. */ } }, [speed]);
  useEffect(() => { const v = videoRef.current; if (!v) return; v.muted = Boolean(muted); if (!autoPlay) { v.pause(); return; } const attempt = () => { if (autoPlay) void v.play().catch(() => {}); }; if (v.readyState >= 2) attempt(); else v.addEventListener('canplay', attempt, { once: true }); return () => v.removeEventListener('canplay', attempt); }, [autoPlay, muted, src, retry]);
  useEffect(() => { const v = videoRef.current; if (!v || playRequest <= 0) return; const attempt = () => { void v.play().catch(() => {}); }; if (v.readyState >= 2) attempt(); else v.addEventListener('canplay', attempt, { once: true }); return () => v.removeEventListener('canplay', attempt); }, [playRequest, src, retry]);
  useEffect(()=>{if(!syncCommand)return;const video=videoRef.current;if(!video)return;const drift=Math.abs((video.currentTime||0)-syncCommand.currentTime);if(drift>2){try{video.currentTime=Math.max(0,syncCommand.currentTime)}catch{}}if(syncCommand.isPlaying){video.play().catch(()=>setError('Tap play to resume the shared Watch Party stream.'))}else{video.pause()}},[syncCommand?.revision]);
  const playPause = async () => { const v = videoRef.current; if (!v) return; setError(''); try { if (v.paused) await v.play(); else v.pause(); } catch { setError('Playback was blocked or the video URL is not playable. Tap Retry or choose another quality.'); } };
  const seek = (by: number) => { const v = videoRef.current; if (v && Number.isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + by)); };
  const fullscreen = async () => { const el = videoRef.current?.parentElement; try { if (document.fullscreenElement) await document.exitFullscreen(); else await el?.requestFullscreen(); } catch { /* Browser restrictions */ } };
  const pictureInPicture = async () => { const v = videoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null; if (!v) return; try { if (document.pictureInPictureElement) { await document.exitPictureInPicture(); } else if (document.pictureInPictureEnabled && v.requestPictureInPicture) { await v.requestPictureInPicture(); } else { setError('Picture-in-Picture is not supported in this browser or Telegram webview. Use Fullscreen instead.'); } } catch { setError('Picture-in-Picture could not start. Try playing the video first, or use Fullscreen.'); } };
  const retrySource = () => { proxiedFallbackRef.current = false; hlsProbeRef.current = false; setError(''); setBuffering(true); setRetry(x => x + 1); };

  if (isMkvSource && !embed && !moviReady) {
    return <section className={'flootStylePlayer' + (reelMode ? ' reelMode' : '')} aria-label="MaseNet MKV video player">
      <div className="flootStyleFrame" style={{ minHeight: 220, display: 'grid', placeItems: 'center', padding: 24, background: '#000', color: '#fff', textAlign: 'center' }}>
        <div><p>{error || 'Preparing MKV playback…'}</p><button type="button" onClick={retrySource}>Retry</button></div>
      </div>
    </section>;
  }

  if (isMkvSource && !embed) {
    return <section className={'flootStylePlayer' + (reelMode ? ' reelMode' : '')} aria-label="MaseNet MKV video player">
      <div className="flootStyleFrame" style={{ minHeight: 220 }}>
        <MoviPlayerTag
          ref={mkvPlayerRef}
          key={episode.id + ':' + rawSrc + ':' + retry}
          src={mkvProxyUrl}
          onError={() => { if (!mkvUseDirectSource) setMkvUseDirectSource(true); }}
          controls
          playsinline
          subtitlepicker
          theme="dark"
          controlslist="nosubtitledrag"
          subtitlesize="1.15"
          subtitlebg="rgba(0,0,0,.65)"
          style={{ display: 'block', width: '100%', height: '100%', minHeight: '220px', aspectRatio: '16 / 9', background: '#000' }}
        >
          {tracks.map((track, index) => {
            const rawTrackUrl = String(track.url || track.path || '').trim();
            const isAbsoluteHttps = /^https:\/\//i.test(rawTrackUrl);
            const trackUrl = isAbsoluteHttps
              ? '/api/media/proxy?episodeId=' + encodeURIComponent(episode.id) + '&resource=' + encodeURIComponent(rawTrackUrl)
              : rawTrackUrl;
            const isSrt = /\.srt(?:$|[?#])/i.test(rawTrackUrl) || /subrip/i.test(track.mimeType || '');
            return <track key={rawTrackUrl + index} kind="subtitles" src={trackUrl} srclang={track.lang || 'und'} label={track.label || track.lang || 'Subtitle ' + (index + 1)} default={index === 0} data-format={isSrt ? 'srt' : undefined} />;
          })}
        </MoviPlayerTag>
      </div>
      <div className="fspControls"><div className="fspRow fspOptions">
        {variants.length > 1 && <label>Quality <select value={selected?.quality || ''} onChange={e => setQuality(e.target.value)}>{variants.map(v => <option key={v.quality + v.streamUrl} value={v.quality}>{v.quality}</option>)}</select></label>}
        <span style={{ color: '#c9ccd5', fontSize: 12 }}>Use the player's own subtitle menu to scroll and choose embedded tracks.</span>
      </div></div>
    </section>;
  }

  return <div className={`flootStylePlayer${reelMode ? ' reelMode' : ''}`}>
    <div className="flootStyleFrame">
      {embed ? <iframe key={embed} src={embed} title={episode.title || 'MaseNet video'} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen /> : <video ref={videoRef} playsInline preload={autoPlay ? "auto" : "metadata"} autoPlay={autoPlay} muted={muted} controls={!reelMode} onClick={reelMode ? playPause : undefined}>{tracks.map((t, i) => <track key={(t.url || t.path || '') + i} kind="subtitles" src={t.url} srcLang={t.lang || 'en'} label={t.label || t.lang || 'Subtitle ' + (i + 1)} />)}</video>}
      {buffering && <div className="fspStatus">⏳ Buffering…</div>}
      {error && <div className="fspError" role="alert"><strong>Playback issue</strong><span>{error}</span><button onClick={retrySource}>Retry</button></div>}
      {!embed && !playing && !error && <button className="fspBigPlay" onClick={playPause} aria-label="Play video">▶</button>}
    </div>
    {!embed && <div className="fspControls">
      <div className="fspRow"><button onClick={playPause} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Ⅱ' : '▶'}</button><button onClick={() => seek(-10)} aria-label="Back 10 seconds">↶ 10s</button><button onClick={() => seek(10)} aria-label="Forward 10 seconds">10s ↷</button><span className="fspTime">{timeLabel(time)} / {timeLabel(duration)}</span><button onClick={pictureInPicture} aria-label="Picture in Picture" title="Picture in Picture">▣</button><button onClick={fullscreen} aria-label="Fullscreen">⛶</button></div>
      <input className="fspSeek" aria-label="Seek video" type="range" min={0} max={duration || 0} step="0.1" value={Math.min(time, duration || 0)} onChange={e => { const n = Number(e.target.value); if (videoRef.current) videoRef.current.currentTime = n; setTime(n); }} />
      <div className="fspRow fspOptions">
        {variants.length > 1 && <label>Quality <select value={selected?.quality || ''} onChange={e => setQuality(e.target.value)}>{variants.map(v => <option key={v.quality + v.streamUrl} value={v.quality}>{v.quality}</option>)}</select></label>}
        <div className="fspSubtitleControl"><button type="button" className="fspSubtitleButton" aria-expanded={subtitleMenuOpen} onClick={() => { setSubtitleMenuOpen(v => !v); setSubtitleNotice(''); }}>▤ Subtitles{subtitle !== 'off' ? ' · On' : ''}</button>{subtitleMenuOpen && <div className="fspSubtitleMenu"><strong>Subtitle track</strong><label className="fspLanguagePreference">Preferred subtitles<select value={preferredSubtitleLanguage} onChange={e=>setPreferredSubtitleLanguage(e.target.value)}><option value="off">Off</option><option value="en">English</option><option value="zh">Chinese</option><option value="ko">Korean</option><option value="ja">Japanese</option><option value="es">Spanish</option><option value="fr">French</option><option value="ar">Arabic</option><option value="hi">Hindi</option><option value="pt">Portuguese</option></select></label><label className="fspLanguagePreference">Preferred audio<select value={preferredAudioLanguage} onChange={e=>setPreferredAudioLanguage(e.target.value)}><option value="auto">Auto / source default</option><option value="en">English</option><option value="zh">Chinese</option><option value="ko">Korean</option><option value="ja">Japanese</option><option value="es">Spanish</option><option value="fr">French</option><option value="ar">Arabic</option><option value="hi">Hindi</option><option value="pt">Portuguese</option></select></label>{hlsAudioTracks.length>0&&<small>Available audio: {hlsAudioTracks.map(t=>t.name||t.lang||'Track').join(', ')}</small>}<button type="button" className={subtitle==='off'?'selected':''} onClick={() => { setSubtitle('off'); const v=videoRef.current; if(v)Array.from(v.textTracks).forEach(t=>t.mode='disabled'); if(hlsRef.current&&isHlsSource){hlsRef.current.subtitleDisplay=false;hlsRef.current.subtitleTrack=-1;} setSubtitleNotice('Subtitles turned off.'); }}>Off</button>{tracks.map((t,i)=><button type="button" className={subtitle==='ext-'+i?'selected':''} key={(t.url||t.path||'')+i} onClick={()=>{const value='ext-'+i;setSubtitle(value);const v=videoRef.current;if(v)Array.from(v.textTracks).forEach((track,j)=>track.mode=j===i?'showing':'disabled');setSubtitleNotice(t.label||t.lang||'Subtitle enabled');}}>{t.label||t.lang||'Subtitle '+(i+1)}</button>)}{(isHlsSource?hlsSubtitleTracks:[]).map((t,i)=><button type="button" className={subtitle==='hls-'+i?'selected':''} key={'hls-'+i} onClick={()=>{const value='hls-'+i;setSubtitle(value);if(hlsRef.current){hlsRef.current.subtitleDisplay=true;hlsRef.current.subtitleTrack=i;}setSubtitleNotice(t.name||t.lang||'HLS subtitle enabled');}}>{t.name||t.lang||'HLS subtitle '+(i+1)}</button>)}{nativeSubtitleTracks.filter(t=>!tracks.some(ext=>(ext.label||ext.lang||'Subtitle track')===t.label)).map((t,i)=><button type="button" className={subtitle==='native-'+i?'selected':''} key={'native-'+i} onClick={()=>{const value='native-'+i;setSubtitle(value);const v=videoRef.current;if(v)Array.from(v.textTracks).forEach(track=>track.mode=(track.label||track.language||'Subtitle track')===t.label?'showing':'disabled');setSubtitleNotice(t.label);}}>{t.label}</button>)}{tracks.length===0&&nativeSubtitleTracks.filter(t=>!tracks.some(ext=>(ext.label||ext.lang||'Subtitle track')===t.label)).length===0&&(!isHlsSource||hlsSubtitleTracks.length===0)&&<p>No browser-readable subtitle track was detected. Embedded MKV subtitles and SRT/ASS files are not directly supported by all browsers. Add a WebVTT (.vtt) subtitle URL or use an HLS stream with subtitle tracks. VLC-only embedded tracks must be extracted or converted first.</p>}{subtitleNotice&&<small>{subtitleNotice}</small>}</div>}</div>
        <label>Speed <select value={speed} onChange={e => { const n = Number(e.target.value); setSpeed(n); if (videoRef.current) videoRef.current.playbackRate = n; }}><option value={0.5}>0.5×</option><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label>
        <label>Volume <input type="range" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))}/></label>
      </div>
    </div>}
    <style>{`.flootStylePlayer{width:100%;color:#f6f4ef;background:#08090d;border:1px solid #ffffff20;border-radius:18px;overflow:hidden}.fspMkvNotice{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;padding:20px;box-sizing:border-box;text-align:center;background:radial-gradient(ellipse at top,#252a39,#050609 75%);overflow:auto}.fspMkvNotice p{max-width:540px;color:#d0d3dc;font-size:13px;line-height:1.5;margin:0}.fspMkvIcon{border:1px solid #ffffff40;background:#ffffff12;border-radius:14px;padding:10px 14px;font-weight:800;letter-spacing:2px}.fspVlcButton{display:inline-flex;align-items:center;justify-content:center;background:#e8c77a;color:#17120a;text-decoration:none;font-weight:800;border-radius:999px;padding:10px 18px;margin-top:3px}.fspDirectLink{color:#eee;text-decoration:underline;font-size:12px}.fspMkvNotice small{color:#aeb4c4;font-size:11px;max-width:520px}.flootStyleFrame{position:relative;aspect-ratio:16/9;background:#000;display:grid;place-items:center}.flootStyleFrame video,.flootStyleFrame iframe{position:absolute;inset:0;width:100%;height:100%;border:0;object-fit:contain;background:#000}.fspStatus{position:absolute;top:12px;left:50%;transform:translateX(-50%);background:#10131bd9;border:1px solid #ffffff24;border-radius:999px;padding:7px 12px;font-size:12px}.fspError{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;text-align:center;padding:20px;background:#08090de8;font-size:13px}.fspError button{padding:8px 15px;border-radius:999px;background:#e8c77a;color:#17120a;border:0;font-weight:700}.fspBigPlay{position:absolute;z-index:2;border:1px solid #ffffff55;border-radius:50%;width:66px;height:66px;background:#d9b96b;color:#17120a;font-size:24px}.fspControls{padding:10px 12px;background:linear-gradient(#15171d,#090a0e)}.fspRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.fspRow button{border:1px solid #ffffff1f;border-radius:9px;background:#ffffff0b;color:inherit;padding:7px 10px;min-height:34px}.fspTime{font-variant-numeric:tabular-nums;font-size:12px;color:#c5c5cb}.fspSeek{width:100%;margin:8px 0;accent-color:#dfbf74}.fspOptions{justify-content:space-between;font-size:12px;color:#d1d1d7}.fspOptions label{display:flex;align-items:center;gap:5px}.fspOptions select{max-width:130px;background:#191b22;color:#fff;border:1px solid #ffffff24;border-radius:8px;padding:6px}.fspOptions input[type=range]{width:70px;accent-color:#dfbf74}@media(max-width:560px){.fspOptions{align-items:flex-start;justify-content:flex-start;gap:10px}.fspOptions label{font-size:11px}.fspOptions select{max-width:105px}}.flootStylePlayer{border-radius:22px;border:1px solid rgba(255,255,255,.13);background:linear-gradient(145deg,#10131c,#050609 70%);box-shadow:0 22px 55px rgba(0,0,0,.32),inset 0 1px rgba(255,255,255,.09);overflow:hidden;isolation:isolate}.flootStyleFrame{aspect-ratio:16/9;min-height:190px;max-height:72vh;background:radial-gradient(ellipse at 50% 20%,rgba(99,110,150,.13),transparent 62%),#020204}.flootStyleFrame:after{content:"";position:absolute;inset:0;pointer-events:none;border:1px solid rgba(255,255,255,.045);box-shadow:inset 0 0 45px rgba(0,0,0,.18)}.flootStyleFrame video,.flootStyleFrame iframe{object-fit:contain}.fspControls{padding:12px 14px 14px;background:linear-gradient(180deg,rgba(23,26,36,.98),rgba(7,8,12,.99));border-top:1px solid rgba(255,255,255,.08)}.fspRow button{border:1px solid rgba(255,255,255,.13);border-radius:12px;background:linear-gradient(145deg,rgba(255,255,255,.095),rgba(255,255,255,.035));box-shadow:inset 0 1px rgba(255,255,255,.07);transition:transform .18s ease,border-color .18s ease,background .18s ease}.fspRow button:hover{border-color:rgba(231,199,122,.55);background:rgba(231,199,122,.1)}.fspRow button:active{transform:scale(.95)}.fspSeek{height:5px;border-radius:999px;cursor:pointer}.fspOptions{gap:12px;padding-top:2px}
  .fspSmartAssist{display:inline-flex;align-items:center;gap:6px;color:#cbd1dc;font-size:11px;white-space:nowrap}.fspSmartDot{width:7px;height:7px;border-radius:50%;background:#8d98a9;box-shadow:0 0 0 3px #8d98a91c}.fspSmartDot.assisting{background:#e8c77a;box-shadow:0 0 0 3px #e8c77a24}.fspSmartDot.recovered{background:#65c98b;box-shadow:0 0 0 3px #65c98b24}.fspSmartDot.unavailable{background:#e58b7b;box-shadow:0 0 0 3px #e58b7b24}.fspOptions label{gap:7px}.fspOptions select{border-radius:999px;padding:7px 10px;background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.12);max-width:140px}.fspOptions input[type=range]{cursor:pointer}.fspBigPlay{width:72px;height:72px;border:1px solid rgba(255,255,255,.8);box-shadow:0 0 0 9px rgba(255,255,255,.075),0 12px 40px rgba(0,0,0,.35),0 0 35px rgba(232,199,122,.18);transition:transform .22s ease,box-shadow .22s ease}.fspBigPlay:hover{transform:scale(1.07);box-shadow:0 0 0 12px rgba(255,255,255,.07),0 12px 40px rgba(0,0,0,.4)}.fspStatus{background:rgba(15,18,29,.88);border-color:rgba(255,255,255,.16);box-shadow:0 8px 28px rgba(0,0,0,.28);backdrop-filter:blur(16px)}.fspError{background:linear-gradient(145deg,rgba(12,14,21,.97),rgba(4,5,8,.96));backdrop-filter:blur(12px)}.fspError strong{font-size:15px;letter-spacing:-.02em}.fspError span{max-width:470px;color:#c6c8d1;line-height:1.55}.fspError button{border:1px solid rgba(255,226,160,.5);box-shadow:0 5px 18px rgba(210,173,96,.12);transition:transform .18s ease}.fspError button:active{transform:scale(.96)}@media(max-width:560px){.flootStylePlayer{border-radius:17px}.flootStyleFrame{min-height:180px}.fspControls{padding:9px}.fspRow{gap:6px}.fspRow button{padding:7px 9px;border-radius:10px}.fspOptions{gap:9px}.fspOptions select{max-width:112px}.fspBigPlay{width:62px;height:62px}}@media(prefers-reduced-motion:reduce){.fspRow button,.fspBigPlay,.fspError button{transition:none!important}}
.fspLanguagePreference{display:grid;gap:5px;padding:7px 0;color:#d6d9e1;font-size:12px}.fspLanguagePreference select{width:100%;min-height:36px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:#161b27;color:#fff;padding:6px 9px}.fspSubtitleControl{position:relative;display:inline-flex;align-items:center}
.fspSubtitleButton{border:1px solid rgba(255,255,255,.24);border-radius:9px;background:rgba(255,255,255,.08);color:#fff;padding:7px 10px;min-height:34px;font-size:12px;font-weight:700}
.fspSubtitleMenu{position:absolute;z-index:30;left:0;bottom:calc(100% + 8px);width:min(260px,78vw);max-height:42vh;overflow:auto;display:flex;flex-direction:column;gap:5px;padding:12px;border:1px solid rgba(255,255,255,.17);border-radius:13px;background:rgba(13,15,21,.98);box-shadow:0 15px 40px #0009;backdrop-filter:blur(18px)}
.fspSubtitleMenu strong{font-size:12px;padding:2px 4px 6px}.fspSubtitleMenu button{width:100%;text-align:left;border:1px solid transparent;border-radius:8px;padding:8px 9px;background:#ffffff0a;color:#f6f6f8;font-size:12px}.fspSubtitleMenu button.selected{border-color:#dfbf74;background:#dfbf7420;color:#f4d891}.fspSubtitleMenu p,.fspSubtitleMenu small{font-size:11px;line-height:1.45;color:#c9ccd5;margin:5px 3px}
/* Reels intentionally use a centered landscape player, not a full-screen portrait crop. */
.reelMode{height:auto!important;min-height:0!important;width:100%;border:0!important;border-radius:0!important;background:#000!important;box-shadow:none!important;display:block!important;overflow:visible!important}
.reelMode .flootStyleFrame{width:100%;aspect-ratio:16/9!important;min-height:0!important;height:auto!important;max-height:32dvh!important;flex:none!important;background:#000}
.reelMode .flootStyleFrame video,.reelMode .flootStyleFrame iframe{object-fit:contain!important;background:#000}
.reelMode .fspControls{display:none!important}
.reelMode .fspBigPlay{width:58px;height:58px}
.reelMode .fspStatus{z-index:3;top:50%}
.reelMode .fspError{z-index:5;max-height:100%;overflow:auto}
@media(min-width:700px){.reelMode .flootStyleFrame{max-height:38dvh!important}}
`}
</style>
  </div>;
}
