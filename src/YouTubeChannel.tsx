import { useMemo, useState } from 'react';
import { ExternalLink, Play, Youtube, X } from 'lucide-react';

const CHANNEL_URL = 'https://www.youtube.com/@masemedia_tv';
const VIDEOS_URL = CHANNEL_URL + '/videos';

function getVideoId(input: string): string {
  const value = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) {
      return url.pathname.split('/').filter(Boolean)[0] || '';
    }
    if (url.hostname.includes('youtube.com') || url.hostname.includes('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v) return v;
      const parts = url.pathname.split('/').filter(Boolean);
      const marker = parts.findIndex(p => ['embed', 'shorts', 'live'].includes(p));
      if (marker >= 0) return parts[marker + 1] || '';
    }
  } catch { /* Not a URL; show a helpful empty state instead. */ }
  return '';
}

export default function YouTubeChannel() {
  const [videoInput, setVideoInput] = useState('');
  const [activeVideo, setActiveVideo] = useState('');
  const [error, setError] = useState('');
  const embedId = useMemo(() => getVideoId(activeVideo), [activeVideo]);

  function playVideo() {
    const id = getVideoId(videoInput);
    if (!id) {
      setError('Paste a valid YouTube video link or its 11-character video ID.');
      return;
    }
    setError('');
    setActiveVideo(id);
  }

  return (
    <section className="maseYouTube" aria-labelledby="mase-youtube-title">
      <style>{`
        .maseYouTube{max-width:1380px;margin:28px auto 42px;padding:0 clamp(12px,2vw,28px);color:#f7f8fc}
        .maseYouTubePanel{position:relative;overflow:hidden;border:1px solid #ffffff20;border-radius:26px;padding:clamp(18px,3vw,30px);background:radial-gradient(ellipse at 90% 0%,#ff003d25,transparent 45%),linear-gradient(135deg,#17131d,#0d111a 72%);box-shadow:0 18px 50px #0004}
        .maseYouTubeHeader{display:flex;align-items:center;gap:14px}
        .maseYouTubeIcon{width:52px;height:52px;display:grid;place-items:center;flex:none;border-radius:17px;background:#ff003d;color:white;box-shadow:0 8px 25px #ff003d35}
        .maseYouTubeEyebrow{font-size:10px;letter-spacing:.17em;text-transform:uppercase;font-weight:850;color:#ff9bad}
        .maseYouTube h2{font-size:clamp(23px,4vw,34px);letter-spacing:-.04em;margin:4px 0 0}
        .maseYouTube p{color:#b8c2d2;line-height:1.65;font-size:13px;max-width:650px;margin:15px 0 20px}
        .maseYouTubeActions{display:flex;flex-wrap:wrap;gap:10px}
        .maseYouTubeActions a,.maseYouTubeActions button{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:43px;padding:0 16px;border-radius:999px;text-decoration:none;font-size:12px;font-weight:850;cursor:pointer}
        .maseYouTubeSubscribe{background:#ff003d;color:white;border:0;box-shadow:0 8px 22px #ff003d26}
        .maseYouTubeVideos{border:1px solid #ffffff2b;background:#ffffff0b;color:#f5f7fc}
        .maseYouTubeActions a:hover,.maseYouTubeActions button:hover{filter:brightness(1.12);transform:translateY(-1px)}
        .maseYouTubePlayer{margin-top:20px;border:1px solid #ffffff20;border-radius:18px;overflow:hidden;background:#050609}
        .maseYouTubePlayerFrame{display:block;width:100%;aspect-ratio:16/9;border:0}
        .maseYouTubeForm{display:flex;gap:8px;margin-top:18px;max-width:720px}
        .maseYouTubeForm input{min-width:0;flex:1;background:#080a10;border:1px solid #ffffff2b;color:#fff;border-radius:12px;padding:12px;font-size:13px}
        .maseYouTubeForm button{border:0;background:#ff003d;color:white;border-radius:12px;padding:0 17px;font-weight:800;cursor:pointer}
        .maseYouTubeNote{display:block;margin-top:12px;color:#8390a4;font-size:10px;line-height:1.5}
        .maseYouTubeError{color:#ffb6c1!important;margin:8px 0 0!important}
        .maseYouTubePlayerTop{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;font-size:12px;color:#b8c2d2}
        .maseYouTubePlayerTop button{display:grid;place-items:center;background:#ffffff12;color:#fff;border:0;border-radius:50%;width:30px;height:30px;cursor:pointer}
        @media(max-width:560px){.maseYouTube{margin:20px auto 30px;padding:0 10px}.maseYouTubePanel{border-radius:20px;padding:17px}.maseYouTubeIcon{width:45px;height:45px;border-radius:14px}.maseYouTube h2{font-size:23px}.maseYouTube p{font-size:12px}.maseYouTubeForm{flex-direction:column}.maseYouTubeForm button{min-height:42px}}
      `}</style>
      <div className="maseYouTubePanel">
        <div className="maseYouTubeHeader">
          <span className="maseYouTubeIcon" aria-hidden="true"><Youtube size={27} /></span>
          <div><span className="maseYouTubeEyebrow">Official channel</span><h2 id="mase-youtube-title">MaseMedia TV</h2></div>
        </div>
        <p>Subscribe to MaseMedia TV or play a YouTube video here without leaving MaseNet. This player is separate from the movie and drama player.</p>
        <div className="maseYouTubeActions">
          <a className="maseYouTubeSubscribe" href={CHANNEL_URL + '?sub_confirmation=1'} target="_blank" rel="noopener noreferrer"><Play size={15} fill="currentColor" /> Subscribe on YouTube <ExternalLink size={13}/></a>
          <a className="maseYouTubeVideos" href={VIDEOS_URL} target="_blank" rel="noopener noreferrer">Browse latest videos <ExternalLink size={13}/></a>
        </div>
        <form className="maseYouTubeForm" onSubmit={e => { e.preventDefault(); playVideo(); }}>
          <input value={videoInput} onChange={e => { setVideoInput(e.target.value); if (error) setError(''); }} placeholder="Paste a YouTube video link to play it here" aria-label="YouTube video link" />
          <button type="submit">Play here</button>
        </form>
        {error && <p className="maseYouTubeError" role="alert">{error}</p>}
        {embedId && <div className="maseYouTubePlayer">
          <div className="maseYouTubePlayerTop"><span>Playing YouTube video on MaseNet</span><button type="button" aria-label="Close YouTube player" onClick={() => setActiveVideo('')}><X size={16}/></button></div>
          <iframe className="maseYouTubePlayerFrame" src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(embedId)}?autoplay=1&rel=0`} title="MaseMedia TV YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
        </div>}
        <small className="maseYouTubeNote">YouTube videos play in this separate embedded player. Automatic latest-upload thumbnails require a verified channel feed; no fake video list is shown.</small>
      </div>
    </section>
  );
}
