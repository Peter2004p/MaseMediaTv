import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Quality = "480p" | "720p" | "1080p";
type Variant = { quality: Quality; streamUrl: string; mimeType?: string; subtitleTracks?: Track[] };
type Episode = { id: string; title: string; quality: Quality; streamUrl: string; mimeType?: string; subtitleTracks?: Track[]; qualities?: Variant[] };
type Props = {
  episode: Episode;
  onProgress?: (percent: number) => void;
  onPlaybackPosition?: (seconds: number) => void;
  onPlaybackStarted?: () => void;
  onPlaybackEnded?: () => void;
  onPlaybackStateChange?: (isPlaying: boolean, currentTime: number) => void;
  syncCommand?: { revision: number; currentTime: number; isPlaying: boolean };
  profileId?: string;
  playRequest?: number;
  resumeAtSeconds?: number;
  autoPlay?: boolean;
  muted?: boolean;
  reelMode?: boolean;
};

type EngineSubtitle = { index: number; label: string; language: string; codec: string; url: string };
type EngineSession = { sessionId: string; playlistUrl: string; subtitles: EngineSubtitle[]; streams: { index: number; codecType: string; codec: string; language?: string; title?: string }[] };

const timeLabel = (n: number) => Number.isFinite(n) ? Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2, "0") : "0:00";
const embedFor = (raw: string) => {
  try {
    const u = new URL(raw), host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return "https://www.youtube.com/embed/" + u.pathname.slice(1).split("/")[0] + "?rel=0";
    if (host.endsWith("youtube.com")) {
      const id = u.searchParams.get("v") || u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)?.[1];
      return id ? "https://www.youtube.com/embed/" + id + "?rel=0" : null;
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const id = u.pathname.match(/(?:video\/)?(\d+)/)?.[1];
      return id ? "https://player.vimeo.com/video/" + id : null;
    }
  } catch {}
  return null;
};

export default function MaseNetEnginePlayer({
  episode, onProgress, onPlaybackPosition, onPlaybackStarted, onPlaybackEnded,
  onPlaybackStateChange, syncCommand, playRequest = 0, resumeAtSeconds = 0,
  autoPlay = false, muted = false, reelMode = false
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const lastSavedRef = useRef(-1);
  const [session, setSession] = useState<EngineSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [selectedSubtitle, setSelectedSubtitle] = useState("off");
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);
  const [audioTracks, setAudioTracks] = useState<{ label: string; lang: string }[]>([]);
  const [selectedAudio, setSelectedAudio] = useState(0);
  const [quality, setQuality] = useState("");
  const variants = episode.qualities?.length ? episode.qualities : [{ quality: episode.quality, streamUrl: episode.streamUrl }];
  const selected = variants.find(v => v.quality === quality) || variants[0];
  const rawSrc = selected?.streamUrl || episode.streamUrl;
  const embed = embedFor(rawSrc);
  useEffect(() => { setQuality(""); }, [episode.id]);
  useEffect(() => {
    setSelectedSubtitle(session?.subtitles?.length ? String(session.subtitles[0].index) : "off");
  }, [session]);

  const startSession = useCallback(async () => {
    if (embed) { setLoading(false); return; }
    setLoading(true); setError(""); setSession(null); setSelectedSubtitle("off");
    hlsRef.current?.destroy(); hlsRef.current = null;
    try {
      const response = await fetch("/api/media/engine/session", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episodeId: episode.id, source: rawSrc })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "MaseNet could not prepare this video.");
      setSession(data as EngineSession);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The new MaseNet media engine could not start.");
    } finally { setLoading(false); }
  }, [episode.id, rawSrc, embed]);

  useEffect(() => { void startSession(); return () => { hlsRef.current?.destroy(); hlsRef.current = null; }; }, [startSession]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !session || embed) return;
    setBuffering(true);
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true, backBufferLength: 30,
        manifestLoadingMaxRetry: 5, levelLoadingMaxRetry: 5, fragLoadingMaxRetry: 5,
        manifestLoadingTimeOut: 30000, levelLoadingTimeOut: 30000, fragLoadingTimeOut: 45000
      });
      hlsRef.current = hls;
      hls.loadSource(session.playlistUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setBuffering(false); setError("");
        const tracks = hls.audioTracks.map((t, i) => ({ label: t.name || t.lang || "Audio " + (i + 1), lang: t.lang || "" }));
        setAudioTracks(tracks);
        if (autoPlay) void video.play().catch(() => {});
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        setAudioTracks(hls.audioTracks.map((t, i) => ({ label: t.name || t.lang || "Audio " + (i + 1), lang: t.lang || "" })));
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        setBuffering(false);
        setError(data.response?.code ? "Media server returned HTTP " + data.response.code + ". Retry playback." : "The media engine could not decode or deliver this source. Retry or check the source link.");
        hls.destroy(); if (hlsRef.current === hls) hlsRef.current = null;
      });
      return () => { hls.destroy(); if (hlsRef.current === hls) hlsRef.current = null; };
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = session.playlistUrl; video.load();
      if (autoPlay) void video.play().catch(() => {});
      return;
    }
    setBuffering(false);
    setError("This browser does not support HLS playback. Open MaseNet in an updated Chrome browser.");
  }, [session, embed, autoPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const metadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (!reelMode && video.duration > 30) {
        const local = Number(localStorage.getItem("masenet-resume-" + episode.id));
        const saved = resumeAtSeconds > 10 ? resumeAtSeconds : local;
        if (Number.isFinite(saved) && saved > 10 && saved < video.duration - 30) video.currentTime = saved;
      }
    };
    const tick = () => {
      setTime(video.currentTime || 0);
      if (video.duration > 0 && Number.isFinite(video.duration)) onProgress?.(Math.round(video.currentTime / video.duration * 100));
      if (!reelMode && video.currentTime > 0) {
        const bucket = Math.floor(video.currentTime / 10);
        if (bucket !== lastSavedRef.current) {
          lastSavedRef.current = bucket;
          onPlaybackPosition?.(Math.floor(video.currentTime));
          try { localStorage.setItem("masenet-resume-" + episode.id, String(Math.floor(video.currentTime))); } catch {}
        }
      }
    };
    const onPlay = () => { setPlaying(true); setBuffering(false); onPlaybackStarted?.(); onPlaybackStateChange?.(true, video.currentTime || 0); };
    const onPause = () => { setPlaying(false); onPlaybackStateChange?.(false, video.currentTime || 0); };
    const onEnded = () => { if (!reelMode) { onPlaybackPosition?.(0); onPlaybackEnded?.(); try { localStorage.removeItem("masenet-resume-" + episode.id); } catch {} } };
    const onWaiting = () => setBuffering(true);
    const onReady = () => { setBuffering(false); setError(""); };
    const onError = () => { if (video.error) { setBuffering(false); setError("Video playback stopped. Check the media server session and retry."); } };
    video.addEventListener("loadedmetadata", metadata); video.addEventListener("timeupdate", tick);
    video.addEventListener("play", onPlay); video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded); video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onReady); video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("loadedmetadata", metadata); video.removeEventListener("timeupdate", tick);
      video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded); video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onReady); video.removeEventListener("error", onError);
    };
  }, [episode.id, resumeAtSeconds, onProgress, onPlaybackPosition, onPlaybackStarted, onPlaybackEnded, onPlaybackStateChange, reelMode]);

  useEffect(() => { const v = videoRef.current; if (!v || !session) return; v.volume = volume; v.playbackRate = speed; }, [volume, speed, session]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !syncCommand || !Number.isFinite(syncCommand.currentTime)) return;
    if (Math.abs(v.currentTime - syncCommand.currentTime) > 2) v.currentTime = syncCommand.currentTime;
    if (syncCommand.isPlaying) void v.play().catch(() => {}); else v.pause();
  }, [syncCommand?.revision]);
  useEffect(() => { if (!playRequest) return; const v = videoRef.current; if (v) void v.play().catch(() => {}); }, [playRequest]);

  const togglePlay = () => { const v = videoRef.current; if (!v) return; if (v.paused) void v.play().catch(() => setError("Tap play again to allow playback.")); else v.pause(); };
  const toggleFullscreen = () => { const el = videoRef.current?.parentElement as HTMLElement & { webkitRequestFullscreen?: () => void } | null; if (el?.requestFullscreen) void el.requestFullscreen(); else el?.webkitRequestFullscreen?.(); };
  const chooseSubtitle = (value: string) => {
    const v = videoRef.current; if (!v) return;
    Array.from(v.querySelectorAll("track")).forEach(node => { (node as HTMLTrackElement).track.mode = "disabled"; });
    if (value !== "off") {
      const track = v.querySelector<HTMLTrackElement>('track[data-engine-subtitle="' + value + '"]');
      if (track) track.track.mode = "showing";
    }
    setSelectedSubtitle(value); setSubtitleMenuOpen(false);
  };
  const chooseAudio = (index: number) => { if (hlsRef.current) hlsRef.current.audioTrack = index; setSelectedAudio(index); };
  const seek = (value: number) => { const v = videoRef.current; if (v && Number.isFinite(value)) v.currentTime = value; };

  return <section className="mnEnginePlayer" style={{ width: "100%", background: "#050609", color: "#fff", borderRadius: 14, overflow: "hidden" }}>
    <style>{`
      .mnEnginePlayer .mnEngineScreen{position:relative;aspect-ratio:16/9;background:#020305;display:flex;align-items:center;justify-content:center}
      .mnEnginePlayer video{width:100%;height:100%;object-fit:contain;background:#000}
      .mnEnginePlayer .mnEngineOverlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#020305b8;flex-direction:column;gap:10px;text-align:center;padding:20px}
      .mnEnginePlayer .mnEngineControls{padding:10px 12px;background:linear-gradient(#171922,#08090d)}
      .mnEnginePlayer .mnEngineControls input[type=range]{width:100%;accent-color:#e2c47d}
      .mnEnginePlayer .mnEngineRow{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      .mnEnginePlayer button,.mnEnginePlayer select{background:#ffffff12;border:1px solid #ffffff25;border-radius:9px;color:#fff;padding:8px 10px;min-height:38px}
      .mnEnginePlayer select option{background:#11151f;color:#fff}
      .mnEnginePlayer .mnEngineTime{font-size:12px;font-variant-numeric:tabular-nums;margin-right:auto}
      .mnEnginePlayer .mnEngineMenu{display:flex;flex-direction:column;gap:7px;padding:10px;background:#10141df5;border:1px solid #ffffff25;border-radius:12px;margin-top:8px;max-height:28vh;overflow:auto}
      .mnEnginePlayer .mnEngineMenu button{text-align:left;min-height:42px}
      .mnEnginePlayer .mnEngineError{color:#ffd3cb;font-size:13px;max-width:520px}
      @media(max-width:520px){.mnEnginePlayer .mnEngineControls{padding:8px}.mnEnginePlayer button,.mnEnginePlayer select{font-size:11px;padding:7px;min-height:42px}.mnEnginePlayer .mnEngineScreen{min-height:180px}}
    `}</style>
    <div className="mnEngineScreen">
      {embed ? <iframe src={embed} title={episode.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen style={{ width: "100%", height: "100%", border: 0, position: "absolute", inset: 0 }} /> : <video ref={videoRef} playsInline preload="metadata" muted={muted}>
        {session?.subtitles?.map(track => <track key={track.index} data-engine-subtitle={String(track.index)} kind="subtitles" src={track.url} srcLang={track.language || "und"} label={track.label} default={track.index === session?.subtitles?.[0]?.index} />)}
      </video>}
      {loading && <div className="mnEngineOverlay"><span>Preparing MaseNet Media Engine…</span><small>Reading video, audio and subtitle tracks</small></div>}
      {buffering && !loading && <div className="mnEngineOverlay"><span>Buffering…</span></div>}
      {error && !loading && <div className="mnEngineOverlay"><div className="mnEngineError">{error}</div><button onClick={() => void startSession()}>Retry playback</button></div>}
      {!loading && !error && !embed && !playing && <button onClick={togglePlay} aria-label="Play video" style={{ position: "absolute", width: 64, height: 64, borderRadius: 40, background: "#e2c47d", color: "#17130a", fontSize: 24 }}>▶</button>}
    </div>
    {!embed && <div className="mnEngineControls">
      <input aria-label="Seek video" type="range" min={0} max={Math.max(duration, 1)} step={0.1} value={Math.min(time, duration || 0)} onChange={e => seek(Number(e.target.value))} />
      <div className="mnEngineRow">
        <button onClick={togglePlay}>{playing ? "Pause" : "Play"}</button>
        <span className="mnEngineTime">{timeLabel(time)} / {timeLabel(duration)}</span>
        <button onClick={() => setVolume(v => v === 0 ? 1 : 0)}>{volume === 0 ? "Unmute" : "Mute"}</button>
        <input aria-label="Volume" type="range" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))} style={{ maxWidth: 84 }} />
        <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[0.5,0.75,1,1.25,1.5,2].map(v => <option key={v} value={v}>{v}×</option>)}</select>
        <button onClick={() => setSubtitleMenuOpen(v => !v)}>Subtitles {selectedSubtitle !== "off" ? "on" : session?.subtitles?.length ? "(" + session.subtitles.length + ")" : ""}</button>
        <button onClick={toggleFullscreen}>Fullscreen</button>
      </div>
      {subtitleMenuOpen && <div className="mnEngineMenu">
        <button onClick={() => chooseSubtitle("off")}>Subtitles off</button>
        {(session?.subtitles || []).map(track => <button key={track.index} onClick={() => chooseSubtitle(String(track.index))}>{track.label} · {track.codec}</button>)}
        {session?.subtitles?.length === 0 && <small>No embedded subtitle tracks detected.</small>}
      </div>}
      {variants.length > 1 && <select aria-label="Video quality" value={selected?.quality || ""} onChange={e => setQuality(e.target.value)}>{variants.map(v => <option key={v.quality} value={v.quality}>{v.quality}</option>)}</select>}
      {audioTracks.length > 1 && <div className="mnEngineRow" style={{ marginTop: 8 }}>
        <label htmlFor="mn-engine-audio" style={{ fontSize: 12 }}>Audio</label>
        <select id="mn-engine-audio" value={selectedAudio} onChange={e => chooseAudio(Number(e.target.value))}>{audioTracks.map((track, i) => <option key={i} value={i}>{track.label}</option>)}</select>
      </div>}
      {session && <small style={{ display: "block", opacity: .55, marginTop: 7 }}>MaseNet FFmpeg playback engine</small>}
    </div>}
  </section>;
}
