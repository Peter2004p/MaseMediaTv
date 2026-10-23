import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';

type Quality = '480p' | '720p' | '1080p';
type Track = { label?: string; url: string; path?: string; lang?: string; mimeType?: string };
type Variant = { quality: Quality; streamUrl: string; mimeType?: string; subtitleTracks?: Track[] };
type Episode = { id: string; title: string; quality: Quality; streamUrl: string; mimeType?: string; subtitleTracks?: Track[]; qualities?: Variant[] };
type Props = { episode: Episode; onProgress?: (percent: number) => void };

const embedFor = (raw: string) => {
  try {
    const u = new URL(raw); const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return 'https://www.youtube.com/embed/' + u.pathname.slice(1).split('/')[0] + '?rel=0';
    if (host.endsWith('youtube.com')) { const id = u.searchParams.get('v') || u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)?.[1]; return id ? 'https://www.youtube.com/embed/' + id + '?rel=0' : null; }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') { const id = u.pathname.match(/(?:video\/)?(\d+)/)?.[1]; return id ? 'https://player.vimeo.com/video/' + id : null; }
  } catch { /* invalid URL */ }
  return null;
};
const timeLabel = (value: number) => Number.isFinite(value) ? Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0') : '0:00';

export default function FlootPlayer({ episode, onProgress }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null); const hlsRef = useRef<Hls | null>(null); const proxiedFallbackRef = useRef(false);
  const [quality, setQuality] = useState(''); const [subtitle, setSubtitle] = useState('off'); const [playing, setPlaying] = useState(false); const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState(''); const [hlsSubtitleTracks, setHlsSubtitleTracks] = useState<{name?:string;lang?:string}[]>([]); const [time, setTime] = useState(0); const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1); const [speed, setSpeed] = useState(1); const [retry, setRetry] = useState(0);
  const variants = useMemo<Variant[]>(() => {
    const values = episode.qualities?.length ? episode.qualities : [{ quality: episode.quality, streamUrl: episode.streamUrl, mimeType: episode.mimeType, subtitleTracks: episode.subtitleTracks }];
    return values.filter((v, i) => !!v.streamUrl && values.findIndex(x => x.quality === v.quality) === i);
  }, [episode]);
  const selected = variants.find(v => v.quality === quality) || variants[0];
  const rawSrc = selected?.streamUrl || episode.streamUrl || ''; 
  const embed = embedFor(rawSrc);
  const tracks = (selected?.subtitleTracks || episode.subtitleTracks || []).filter(t => {
    const value = String(t.url || t.path || '').trim();
    return /^https?:\/\//i.test(value) && /\.(?:vtt|srt|ass|ssa)(?:$|[?#])/i.test(value);
  }).map(t => ({ ...t, url: String(t.url || t.path).trim() }));
  const isHlsSource = /\.m3u8(?:$|[?#])/i.test(rawSrc) || /mpegurl/i.test(selected?.mimeType || episode.mimeType || '');
  const isMkvSource = /\.mkv(?:$|[?#])/i.test(rawSrc) || /matroska|x-matroska/i.test(selected?.mimeType || episode.mimeType || '');
  const vlcIntent = '';
  const src = isHlsSource ? '/api/media/proxy?episodeId=' + encodeURIComponent(episode.id) + '&source=' + encodeURIComponent(rawSrc) : rawSrc;

  useEffect(() => { setQuality(''); setSubtitle('off'); }, [episode.id]);

  useEffect(() => {
    const video = videoRef.current; if (!video) return;
    setError(''); setHlsSubtitleTracks([]); setBuffering(false); setTime(0); setDuration(0); setPlaying(false); proxiedFallbackRef.current = false;
    hlsRef.current?.destroy(); hlsRef.current = null;
    if (!src || embed) return;
    if (isHlsSource && !video.canPlayType('application/vnd.apple.mpegurl')) {
      if (!Hls.isSupported()) { setError('This browser cannot play HLS streams. Try another quality or a direct MP4 URL.'); return; }
      const hls = new Hls({ enableWorker: true, backBufferLength: 30 }); hlsRef.current = hls;
      hls.loadSource(src); hls.attachMedia(video);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { setHlsSubtitleTracks(hls.subtitleTracks.map(t => ({name:t.name,lang:t.lang}))); if (hls.subtitleTracks.length && subtitle.startsWith('hls-')) hls.subtitleTrack = Number(subtitle.slice(4)); });
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { setBuffering(false); setError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'Stream network error. The source may be offline or blocking playback. Tap Retry to reconnect.' : 'This browser cannot decode this stream. Try another quality or a browser-compatible MP4/HLS source.'); hls.destroy(); hlsRef.current = null; } });
    } else { video.src = isHlsSource ? src : rawSrc; video.load(); }
    return () => { hlsRef.current?.destroy(); hlsRef.current = null; };
  }, [src, rawSrc, embed, isHlsSource, isMkvSource, selected?.mimeType, episode.mimeType, retry]);

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const metadata = () => setDuration(Number.isFinite(v.duration) ? v.duration : 0);
    const tick = () => { setTime(v.currentTime || 0); if (v.duration > 0 && Number.isFinite(v.duration)) onProgress?.(Math.round(v.currentTime / v.duration * 100)); };
    const play = () => { setPlaying(true); setBuffering(false); setError(''); }; const pause = () => setPlaying(false);
    const wait = () => setBuffering(true); const ready = () => { setBuffering(false); setError(''); };
    const fail = () => { setBuffering(false); if (!v.error) return; if ([2, 3, 4].includes(v.error.code) && !isHlsSource && !proxiedFallbackRef.current && rawSrc && /^https:\/\//i.test(rawSrc)) { proxiedFallbackRef.current = true; setError('Trying the stream through MaseNet’s secure video proxy…'); v.src = '/api/media/proxy?episodeId=' + encodeURIComponent(episode.id) + '&source=' + encodeURIComponent(rawSrc); v.load(); return; } setError((({2:'Network error loading this video. The source may be offline, expired, or blocking playback.',3:'This browser cannot decode this video or audio codec. The link may work in VLC but use a format or codec this browser does not support.',4:'The browser rejected this stream format. The link may be a streaming endpoint or MKV source rather than a browser-compatible video. MaseNet tried a same-site stream fallback; if it still fails, this source needs a browser-compatible MP4/HLS version.'} as Record<number,string>)[v.error.code] || 'Video playback failed. Check the source URL or retry.')); };
    v.addEventListener('loadedmetadata', metadata); v.addEventListener('timeupdate', tick); v.addEventListener('play', play); v.addEventListener('pause', pause); v.addEventListener('waiting', wait); v.addEventListener('canplay', ready); v.addEventListener('error', fail);
    return () => { v.removeEventListener('loadedmetadata', metadata); v.removeEventListener('timeupdate', tick); v.removeEventListener('play', play); v.removeEventListener('pause', pause); v.removeEventListener('waiting', wait); v.removeEventListener('canplay', ready); v.removeEventListener('error', fail); };
  }, [onProgress, isMkvSource, isHlsSource, rawSrc, episode.id]);

  useEffect(() => { const v = videoRef.current; if (v) v.volume = volume; }, [volume]);
  const playPause = async () => { const v = videoRef.current; if (!v) return; setError(''); try { if (v.paused) await v.play(); else v.pause(); } catch { setError('Playback was blocked or the video URL is not playable. Tap Retry or choose another quality.'); } };
  const seek = (by: number) => { const v = videoRef.current; if (v && Number.isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + by)); };
  const fullscreen = async () => { const el = videoRef.current?.parentElement; try { if (document.fullscreenElement) await document.exitFullscreen(); else await el?.requestFullscreen(); } catch { /* Browser restrictions */ } };
  const retrySource = () => { setError(''); setRetry(x => x + 1); };

  return <div className="flootStylePlayer">
    <div className="flootStyleFrame">
      {embed ? <iframe key={embed} src={embed} title={episode.title || 'MaseNet video'} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen /> : <video ref={videoRef} playsInline preload="metadata" controls={false}>{tracks.map((t, i) => <track key={(t.url || t.path || '') + i} kind="subtitles" src={t.url} srcLang={t.lang || 'en'} label={t.label || t.lang || 'Subtitle ' + (i + 1)} />)}</video>}
      {buffering && <div className="fspStatus">⏳ Buffering…</div>}
      {error && <div className="fspError" role="alert"><strong>Playback issue</strong><span>{error}</span><button onClick={retrySource}>Retry</button></div>}
      {!embed && !playing && !error && <button className="fspBigPlay" onClick={playPause} aria-label="Play video">▶</button>}
    </div>
    {!embed && <div className="fspControls">
      <div className="fspRow"><button onClick={playPause} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Ⅱ' : '▶'}</button><button onClick={() => seek(-10)} aria-label="Back 10 seconds">↶ 10s</button><button onClick={() => seek(10)} aria-label="Forward 10 seconds">10s ↷</button><span className="fspTime">{timeLabel(time)} / {timeLabel(duration)}</span><button onClick={fullscreen} aria-label="Fullscreen">⛶</button></div>
      <input className="fspSeek" aria-label="Seek video" type="range" min={0} max={duration || 0} step="0.1" value={Math.min(time, duration || 0)} onChange={e => { const n = Number(e.target.value); if (videoRef.current) videoRef.current.currentTime = n; setTime(n); }} />
      <div className="fspRow fspOptions">
        {variants.length > 1 && <label>Quality <select value={selected?.quality || ''} onChange={e => setQuality(e.target.value)}>{variants.map(v => <option key={v.quality + v.streamUrl} value={v.quality}>{v.quality}</option>)}</select></label>}
        {(tracks.length > 0 || (isHlsSource && hlsSubtitleTracks.length > 0)) && <label>Subtitles <select value={subtitle} onChange={e => { const value = e.target.value; setSubtitle(value); const v = videoRef.current; if (v) Array.from(v.textTracks).forEach((t, i) => { t.mode = value === 'ext-' + i ? 'showing' : 'disabled'; }); if (hlsRef.current && isHlsSource) hlsRef.current.subtitleTrack = value.startsWith('hls-') ? Number(value.slice(4)) : -1; }}>{<option value="off">Off</option>}{tracks.map((t, i) => <option key={(t.url || t.path || '') + i} value={'ext-' + i}>{t.label || t.lang || 'Subtitle ' + (i + 1)}</option>)}{(isHlsSource ? hlsSubtitleTracks : []).map((t, i) => <option key={'hls-' + i} value={'hls-' + i}>{t.name || t.lang || 'HLS subtitle ' + (i + 1)}</option>)}</select></label>}
        <label>Speed <select value={speed} onChange={e => { const n = Number(e.target.value); setSpeed(n); if (videoRef.current) videoRef.current.playbackRate = n; }}><option value={0.5}>0.5×</option><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label>
        <label>Volume <input type="range" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))}/></label>
      </div>
    </div>}
    <style>{`.flootStylePlayer{width:100%;color:#f6f4ef;background:#08090d;border:1px solid #ffffff20;border-radius:18px;overflow:hidden}.fspMkvNotice{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;padding:20px;box-sizing:border-box;text-align:center;background:radial-gradient(ellipse at top,#252a39,#050609 75%);overflow:auto}.fspMkvNotice p{max-width:540px;color:#d0d3dc;font-size:13px;line-height:1.5;margin:0}.fspMkvIcon{border:1px solid #ffffff40;background:#ffffff12;border-radius:14px;padding:10px 14px;font-weight:800;letter-spacing:2px}.fspVlcButton{display:inline-flex;align-items:center;justify-content:center;background:#e8c77a;color:#17120a;text-decoration:none;font-weight:800;border-radius:999px;padding:10px 18px;margin-top:3px}.fspDirectLink{color:#eee;text-decoration:underline;font-size:12px}.fspMkvNotice small{color:#aeb4c4;font-size:11px;max-width:520px}.flootStyleFrame{position:relative;aspect-ratio:16/9;background:#000;display:grid;place-items:center}.flootStyleFrame video,.flootStyleFrame iframe{position:absolute;inset:0;width:100%;height:100%;border:0;object-fit:contain;background:#000}.fspStatus{position:absolute;top:12px;left:50%;transform:translateX(-50%);background:#10131bd9;border:1px solid #ffffff24;border-radius:999px;padding:7px 12px;font-size:12px}.fspError{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;text-align:center;padding:20px;background:#08090de8;font-size:13px}.fspError button{padding:8px 15px;border-radius:999px;background:#e8c77a;color:#17120a;border:0;font-weight:700}.fspBigPlay{position:absolute;z-index:2;border:1px solid #ffffff55;border-radius:50%;width:66px;height:66px;background:#d9b96b;color:#17120a;font-size:24px}.fspControls{padding:10px 12px;background:linear-gradient(#15171d,#090a0e)}.fspRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.fspRow button{border:1px solid #ffffff1f;border-radius:9px;background:#ffffff0b;color:inherit;padding:7px 10px;min-height:34px}.fspTime{font-variant-numeric:tabular-nums;font-size:12px;color:#c5c5cb}.fspSeek{width:100%;margin:8px 0;accent-color:#dfbf74}.fspOptions{justify-content:space-between;font-size:12px;color:#d1d1d7}.fspOptions label{display:flex;align-items:center;gap:5px}.fspOptions select{max-width:130px;background:#191b22;color:#fff;border:1px solid #ffffff24;border-radius:8px;padding:6px}.fspOptions input[type=range]{width:70px;accent-color:#dfbf74}@media(max-width:560px){.fspOptions{align-items:flex-start;justify-content:flex-start;gap:10px}.fspOptions label{font-size:11px}.fspOptions select{max-width:105px}}.flootStylePlayer{border-radius:22px;border:1px solid rgba(255,255,255,.13);background:linear-gradient(145deg,#10131c,#050609 70%);box-shadow:0 22px 55px rgba(0,0,0,.32),inset 0 1px rgba(255,255,255,.09);overflow:hidden;isolation:isolate}.flootStyleFrame{aspect-ratio:16/9;min-height:190px;max-height:72vh;background:radial-gradient(ellipse at 50% 20%,rgba(99,110,150,.13),transparent 62%),#020204}.flootStyleFrame:after{content:"";position:absolute;inset:0;pointer-events:none;border:1px solid rgba(255,255,255,.045);box-shadow:inset 0 0 45px rgba(0,0,0,.18)}.flootStyleFrame video,.flootStyleFrame iframe{object-fit:contain}.fspControls{padding:12px 14px 14px;background:linear-gradient(180deg,rgba(23,26,36,.98),rgba(7,8,12,.99));border-top:1px solid rgba(255,255,255,.08)}.fspRow button{border:1px solid rgba(255,255,255,.13);border-radius:12px;background:linear-gradient(145deg,rgba(255,255,255,.095),rgba(255,255,255,.035));box-shadow:inset 0 1px rgba(255,255,255,.07);transition:transform .18s ease,border-color .18s ease,background .18s ease}.fspRow button:hover{border-color:rgba(231,199,122,.55);background:rgba(231,199,122,.1)}.fspRow button:active{transform:scale(.95)}.fspSeek{height:5px;border-radius:999px;cursor:pointer}.fspOptions{gap:12px;padding-top:2px}.fspOptions label{gap:7px}.fspOptions select{border-radius:999px;padding:7px 10px;background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.12);max-width:140px}.fspOptions input[type=range]{cursor:pointer}.fspBigPlay{width:72px;height:72px;border:1px solid rgba(255,255,255,.8);box-shadow:0 0 0 9px rgba(255,255,255,.075),0 12px 40px rgba(0,0,0,.35),0 0 35px rgba(232,199,122,.18);transition:transform .22s ease,box-shadow .22s ease}.fspBigPlay:hover{transform:scale(1.07);box-shadow:0 0 0 12px rgba(255,255,255,.07),0 12px 40px rgba(0,0,0,.4)}.fspStatus{background:rgba(15,18,29,.88);border-color:rgba(255,255,255,.16);box-shadow:0 8px 28px rgba(0,0,0,.28);backdrop-filter:blur(16px)}.fspError{background:linear-gradient(145deg,rgba(12,14,21,.97),rgba(4,5,8,.96));backdrop-filter:blur(12px)}.fspError strong{font-size:15px;letter-spacing:-.02em}.fspError span{max-width:470px;color:#c6c8d1;line-height:1.55}.fspError button{border:1px solid rgba(255,226,160,.5);box-shadow:0 5px 18px rgba(210,173,96,.12);transition:transform .18s ease}.fspError button:active{transform:scale(.96)}@media(max-width:560px){.flootStylePlayer{border-radius:17px}.flootStyleFrame{min-height:180px}.fspControls{padding:9px}.fspRow{gap:6px}.fspRow button{padding:7px 9px;border-radius:10px}.fspOptions{gap:9px}.fspOptions select{max-width:112px}.fspBigPlay{width:62px;height:62px}}@media(prefers-reduced-motion:reduce){.fspRow button,.fspBigPlay,.fspError button{transition:none!important}`}</style>
  </div>;
}
