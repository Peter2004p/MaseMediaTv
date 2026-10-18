import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, RotateCcw, RotateCw, Subtitles, Settings, Download, AlertCircle, LoaderCircle } from 'lucide-react';

type Quality = '480p' | '720p' | '1080p';
type Episode = {
  id: string; season: number; episode: number; title: string; quality: Quality;
  streamUrl: string; mimeType?: string; downloadUrl?: string;
  subtitleTracks?: { label: string; url: string; lang?: string; mimeType?: string }[];
};
const formatTime = (value: number) => {
  if (!Number.isFinite(value) || value < 0) value = 0;
  return Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
};

export default function Player({ episode, onProgress }: { episode: Episode; onProgress: (n: number) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const onProgressRef = useRef(onProgress);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [menu, setMenu] = useState<'quality' | 'subtitles' | ''>('');
  const [quality, setQuality] = useState(-1);
  const [subtitle, setSubtitle] = useState(-1);
  const [fullscreen, setFullscreen] = useState(false);
  const tracks = episode.subtitleTracks || [];

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: Hls | null = null;
    let disposed = false;
    setError(''); setLoading(true); setTime(0); setDuration(0); setPlaying(false); setQuality(-1); setSubtitle(-1);
    video.pause(); video.removeAttribute('src');
    video.querySelectorAll('track').forEach(node => node.remove());
    const originalSource = (episode.streamUrl || '').trim();
    const isHls = /\.m3u8(?:$|[?#])/i.test(originalSource) || /mpegurl/i.test(episode.mimeType || '');
    const isMkv = /\.mkv(?:$|[?#])/i.test(originalSource) || /matroska/i.test(episode.mimeType || '');
    // Use the proxy for HLS manifests and MKV sources; play normal MP4/WebM/MOV URLs directly.
    // The proxy does not transcode codecs, so unsupported MKV codecs still need a server-side transcoder.
    const source = isMkv ? '/api/media/convert?episodeId=' + encodeURIComponent(episode.id) : isHls ? '/api/media/proxy?episodeId=' + encodeURIComponent(episode.id) + '&source=' + encodeURIComponent(originalSource) : originalSource;
    const fail = () => {
      if (video.error && !disposed) {
        setLoading(false);
        setError(isMkv ? 'MaseTv could not convert this MKV stream. The source may be offline, blocked, or contain unsupported codecs. Try another quality or ask the admin to check the link.' : 'The video could not be loaded. Check that the link is public, points directly to a video file, and the source server is online.');
      }
    };
    const ready = () => { if (!disposed) setLoading(false); };
    const metadata = () => { if (!disposed) { setDuration(Number.isFinite(video.duration) ? video.duration : 0); setLoading(false); } };
    const tick = () => {
      if (disposed) return;
      const current = Number(video.currentTime) || 0;
      const total = Number.isFinite(video.duration) ? video.duration : 0;
      setTime(current); setDuration(total);
      if (total > 0) onProgressRef.current(Math.min(99, Math.round(current / total * 100)));
    };
    const ended = () => { onProgressRef.current(100); setPlaying(false); };
    const waiting = () => { if (!disposed) setLoading(true); };
    const playingEvent = () => { if (!disposed) { setLoading(false); setPlaying(true); } };
    const pauseEvent = () => { if (!disposed) setPlaying(false); };
    video.addEventListener('error', fail);
    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('canplay', ready);
    video.addEventListener('waiting', waiting);
    video.addEventListener('playing', playingEvent);
    video.addEventListener('pause', pauseEvent);
    video.addEventListener('timeupdate', tick);
    video.addEventListener('ended', ended);
    tracks.forEach((track, index) => {
      const node = document.createElement('track');
      node.kind = 'subtitles'; node.src = track.url; node.srclang = track.lang || 'und';
      node.label = track.label; node.default = index === 0; video.appendChild(node);
    });
    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
      hlsRef.current = hls;
      hls.loadSource(source); hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!disposed) setLoading(false); });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => { if (!disposed) setQuality(data.level); });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || disposed) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
        else { setLoading(false); setError('This stream could not be loaded. Please try again later or ask the administrator to check the video link.'); }
      });
    } else if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source;
      video.load();
    } else {
      video.src = source;
      video.load();
    }
    return () => {
      disposed = true;
      if (hls) hls.destroy();
      hlsRef.current = null;
      video.removeEventListener('error', fail);
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('waiting', waiting);
      video.removeEventListener('playing', playingEvent);
      video.removeEventListener('pause', pauseEvent);
      video.removeEventListener('timeupdate', tick);
      video.removeEventListener('ended', ended);
    };
  }, [episode.id, episode.streamUrl, episode.mimeType, reload, episode.subtitleTracks]);

  useEffect(() => {
    const update = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setError('Playback was blocked. Tap Play again or check the source URL.'));
    else video.pause();
  };
  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  };
  const toggleFullscreen = () => {
    const element = stageRef.current;
    if (!element) return;
    if (!document.fullscreenElement) void element.requestFullscreen?.();
    else void document.exitFullscreen?.();
  };
  const chooseSubtitle = (index: number) => {
    const video = videoRef.current;
    if (!video) return;
    Array.from(video.textTracks).forEach((track, i) => { track.mode = i === index ? 'showing' : 'disabled'; });
    setSubtitle(index); setMenu('');
  };
  const levels = hlsRef.current?.levels || [];
  const chooseQuality = (index: number) => {
    if (!hlsRef.current) return;
    hlsRef.current.currentLevel = index; setQuality(index); setMenu('');
  };

  return <section className='vlcPlayer glass' aria-label='MaseTv video player'>
    <div className='videoStage maseStage' ref={stageRef}>
      <video ref={videoRef} className='masePlayerVideo' playsInline preload='metadata' onClick={togglePlay} />
      {loading && !error && <div className='playerLoading'><LoaderCircle size={26} className='playerSpinner' /><span>Loading stream…</span></div>}
      {!playing && !loading && !error && <button type='button' className='centerPlay' aria-label='Play video' onClick={togglePlay}><Play fill='currentColor' /></button>}
      <div className='playerTop'><b>{episode.title}</b><span>S{episode.season} · E{episode.episode} · {episode.quality}</span></div>
      {error && <div className='playerOverlayError' role='alert'><AlertCircle size={20} /><div className='playerErrorCopy'><b>Unable to play this video</b><span>{error}</span></div><button type='button' onClick={() => setReload(value => value + 1)}>Try again</button></div>}
      <div className='playerChrome'>
        <input aria-label='Seek video' className='seek' type='range' min={0} max={duration || 100} step={1} value={Math.min(time, duration || 100)} onChange={event => { const video = videoRef.current; if (video && duration) video.currentTime = Number(event.target.value); }} />
        <div className='controlRow'>
          <button className='icon' type='button' onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
          <button className='icon' type='button' onClick={() => seek(-10)} aria-label='Back 10 seconds'><RotateCcw size={16} /></button>
          <button className='icon' type='button' onClick={() => seek(10)} aria-label='Forward 10 seconds'><RotateCw size={16} /></button>
          <span className='time'>{formatTime(time)} / {formatTime(duration)}</span><span className='playerSpacer' />
          <button className='icon volume' type='button' onClick={() => { const video = videoRef.current; if (video) { video.muted = !video.muted; setMuted(video.muted); } }} aria-label='Mute or unmute'>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
          <input aria-label='Volume' className='volume' type='range' min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={event => { const next = Number(event.target.value); setVolume(next); setMuted(next === 0); if (videoRef.current) { videoRef.current.volume = next; videoRef.current.muted = next === 0; } }} />
          <button className='icon' type='button' onClick={() => setMenu(menu === 'quality' ? '' : 'quality')} aria-label='Playback settings'><Settings size={16} /></button>
          <button className='icon' type='button' onClick={() => setMenu(menu === 'subtitles' ? '' : 'subtitles')} aria-label='Subtitles'><Subtitles size={16} /></button>
          <button className='icon' type='button' onClick={toggleFullscreen} aria-label='Fullscreen'>{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</button>
        </div>
      </div>
      {menu === 'quality' && <div className='playerMenu'><b>Stream quality</b><div>{levels.length ? <><button className={quality === -1 ? 'selected' : ''} onClick={() => chooseQuality(-1)}>Auto</button>{levels.map((level, index) => <button key={index} className={quality === index ? 'selected' : ''} onClick={() => chooseQuality(index)}>{level.height ? level.height + 'p' : 'Level ' + (index + 1)}</button>)}</> : <span className='playerHint'>Quality choices are available for adaptive HLS streams. Separate uploaded URLs use the episode quality selector.</span>}</div><b>Speed</b><div>{[0.75, 1, 1.25, 1.5, 2].map(value => <button key={value} className={rate === value ? 'selected' : ''} onClick={() => { setRate(value); if (videoRef.current) videoRef.current.playbackRate = value; setMenu(''); }}>{value === 1 ? 'Normal' : value + '×'}</button>)}</div></div>}
      {menu === 'subtitles' && <div className='playerMenu'><b>Subtitles</b><div><button className={subtitle === -1 ? 'selected' : ''} onClick={() => chooseSubtitle(-1)}>Off</button>{tracks.map((track, index) => <button key={track.url + index} className={subtitle === index ? 'selected' : ''} onClick={() => chooseSubtitle(index)}>{track.label}</button>)}</div><span className='playerHint'>Only subtitle tracks supplied with this episode can be selected.</span></div>}
    </div>
    {episode.downloadUrl && <div className='playerDownload'><a className='secondary' href={episode.downloadUrl} target='_blank' rel='noopener noreferrer'><Download size={14} /> Download video</a></div>}
    <div className='playerHint'>MaseTv uses the browser playback engine plus its media proxy/conversion route. MKV and unsupported codecs need a reachable server-side converter; no browser can guarantee every encrypted, blocked, or proprietary stream.</div>
  </section>;
}
