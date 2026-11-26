import { useEffect, useRef, useState, type CSSProperties, type TouchEvent, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight, BellRing, Bot, Check, Clapperboard, Chrome, Download, Film, Languages, LoaderCircle, Mail, Moon, RotateCcw, Sparkles, Sun, Tv2 } from 'lucide-react';
import './onboarding-liquid-glass.css';

type Props = { open: boolean; onClose: () => void; onReopen: () => void; onGoogleLogin: () => Promise<boolean>; onTelegramLogin: () => Promise<boolean>; onEmailVerified: (user: {userId:string;name?:string;email?:string;picture?:string}) => void };
type ThemeChoice = 'light' | 'dark' | 'system';

const genres = ['C-Drama & K-Drama', 'Action & Thriller', 'Romance', 'Historical & Wuxia', 'Mystery & Horror', 'Anime & Cartoons'];
const featureCards = [
  { icon: <Tv2 size={19}/>, title: 'Multi-Format & HLS Playback', copy: 'A flexible player for MP4, MKV and adaptive HLS (.m3u8) sources.', detail: 'Use the built-in player with available playback options. Multi-language WebVTT subtitle tracks appear when they are supplied with the title and supported by the source.' },
  { icon: <BellRing size={19}/>, title: 'Instant Episode Alerts & Watchlist', copy: 'Keep titles close and follow updates for the dramas you love.', detail: 'Save titles to your watchlist and check MaseNet announcements for new episode drops. Signed-in progress and alerts depend on the account and title data available.' },
  { icon: <Download size={19}/>, title: 'Fast Direct Downloads', copy: 'Choose a convenient quality when a download is available.', detail: 'Available source qualities can include 480p, 576p, 720p, 1080p and 4K. The choices shown depend on the title and its uploaded files.' }
];

export default function OnboardingTour({ open, onClose, onReopen, onGoogleLogin, onTelegramLogin, onEmailVerified }: Props) {
  const [step, setStep] = useState(0);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => {
    try { return (localStorage.getItem('masenet-onboarding-theme') as ThemeChoice) || 'system'; } catch { return 'system'; }
  });
  const [selectedGenres, setSelectedGenres] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem('masenet-onboarding-genres') || '[]'); return Array.isArray(saved) ? saved.filter((x): x is string => genres.includes(x)) : []; } catch { return []; }
  });
  const [expandedFeature, setExpandedFeature] = useState<number | null>(0);\n  const [email,setEmail]=useState('');\n  const [otp,setOtp]=useState('');\n  const [emailStage,setEmailStage]=useState<'email'|'code'>('email');\n  const [emailBusy,setEmailBusy]=useState(false);\n  const [emailMessage,setEmailMessage]=useState('');\n  const [authBusy,setAuthBusy]=useState<'google'|'telegram'|null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const touchStart = useRef<{x:number;y:number}|null>(null);

  useEffect(() => {
    try { localStorage.setItem('masenet-onboarding-theme', themeChoice); } catch {}
  }, [themeChoice]);

  useEffect(() => {
    try { localStorage.setItem('masenet-onboarding-genres', JSON.stringify(selectedGenres)); } catch {}
    window.dispatchEvent(new CustomEvent('masenet:genres-updated', { detail: { genres: selectedGenres } }));
  }, [selectedGenres]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setStep(v => Math.min(3, v + 1)); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setStep(v => Math.max(0, v - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || step !== 3 || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bounds = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(bounds.width * dpr));
    canvas.height = Math.max(1, Math.round(bounds.height * dpr));
    ctx.scale(dpr, dpr);
    const colors = ['#70f0bd', '#9fc5ff', '#d9b7ff', '#ffd58b', '#ffffff'];
    const particles = Array.from({length: 92}, (_, i) => ({
      x: bounds.width * .5, y: bounds.height * .32,
      vx: (Math.random() - .5) * 8, vy: Math.random() * -7 - 2,
      gravity: .13 + Math.random() * .1, size: 2 + Math.random() * 3,
      rotation: Math.random() * 6, spin: (Math.random() - .5) * .2,
      color: colors[i % colors.length], life: 70 + Math.random() * 40
    }));
    let frame = 0;
    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, bounds.width, bounds.height);
      particles.forEach(p => {
        if (p.life <= 0) return;
        p.x += p.vx; p.y += p.vy; p.vy += p.gravity; p.rotation += p.spin; p.life -= 1;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.globalAlpha = Math.min(1, p.life / 24);
        ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size, p.size, p.size * 2.2); ctx.restore();
      });
      frame += 1;
      if (frame < 115) raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [open, step]);

  const close = () => onClose();
  const replay = () => { setStep(0); setExpandedFeature(0); };
  const toggleGenre = (genre: string) => setSelectedGenres(current => current.includes(genre) ? current.filter(item => item !== genre) : [...current, genre]);
  const next = () => setStep(current => Math.min(3, current + 1));\n  const handleGoogle=async()=>{setAuthBusy('google');try{if(await onGoogleLogin())onClose()}finally{setAuthBusy(null)}};\n  const handleTelegram=async()=>{setAuthBusy('telegram');try{if(await onTelegramLogin())onClose()}finally{setAuthBusy(null)}};\n  const sendEmailCode=async()=>{if(emailBusy)return;setEmailBusy(true);setEmailMessage('');try{const response=await fetch('/api/auth/email/send',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Could not send your sign-in code.');setEmailStage('code');setEmailMessage('A six-digit sign-in code has been sent if this address is eligible. Check your inbox.')}catch(error){setEmailMessage(error instanceof Error?error.message:'Email sign-in is temporarily unavailable.')}finally{setEmailBusy(false)}};\n  const verifyEmailCode=async()=>{if(emailBusy)return;setEmailBusy(true);setEmailMessage('');try{const response=await fetch('/api/auth/email/verify',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email,code:otp})});const data=await response.json().catch(()=>({}));if(!response.ok||!data.user)throw new Error(data.error||'That code could not be verified.');onEmailVerified(data.user)}catch(error){setEmailMessage(error instanceof Error?error.message:'Email verification failed.')}finally{setEmailBusy(false)}};
  const previous = () => setStep(current => Math.max(0, current - 1));
  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => { const touch = event.changedTouches[0]; touchStart.current = {x: touch.clientX, y: touch.clientY}; };
  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (!touchStart.current) return;
    const touch = event.changedTouches[0]; const dx = touch.clientX - touchStart.current.x; const dy = touch.clientY - touchStart.current.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.25) dx < 0 ? next() : previous();
    touchStart.current = null;
  };
  const tiltStage = (event: MouseEvent<HTMLDivElement>) => {
    if (!stageRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    stageRef.current.style.setProperty('--tilt-x', String(-y * 9) + 'deg');
    stageRef.current.style.setProperty('--tilt-y', String(x * 11) + 'deg');
  };

  return <>
    {!open && <button className="mnTourReopen" type="button" onClick={() => { replay(); onReopen(); }} aria-label="Open MaseNet welcome tour"><Sparkles size={15}/> <span>Tour</span></button>}
    {open && <div className="mnTourOverlay" role="presentation" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="mnTourCard" role="dialog" aria-modal="true" aria-label="Welcome to MaseNet" data-theme={themeChoice} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        <div className="mnTourGlow" aria-hidden="true"/>
        <header className="mnTourTopbar">
          <div className="mnTourBrand"><span className="mnTourBrandMark"><Clapperboard size={17}/></span><span><b>MaseNet</b><small>YOUR ENTERTAINMENT SPACE</small></span></div>
          <div className="mnTourTopActions">
            <div className="mnTourTheme" role="group" aria-label="Onboarding appearance">
              <button type="button" className={themeChoice === 'light' ? 'active' : ''} onClick={() => setThemeChoice('light')} aria-label="Light theme"><Sun size={14}/><span>Light</span></button>
              <button type="button" className={themeChoice === 'dark' ? 'active' : ''} onClick={() => setThemeChoice('dark')} aria-label="Dark theme"><Moon size={14}/><span>Dark</span></button>
              <button type="button" className={themeChoice === 'system' ? 'active' : ''} onClick={() => setThemeChoice('system')} aria-label="System theme"><span className="mnTourSystemIcon">◐</span><span>System</span></button>
            </div>
            <button type="button" className="mnTourSkip" onClick={close}>Skip</button>
          </div>
        </header>
        <div className="mnTourProgress" aria-label={`Step ${step + 1} of 4`}>
          {[0,1,2,3].map(index => <span key={index} className={index <= step ? 'filled' : ''}><i/></span>)}
        </div>
        <div className="mnTourStep" key={step}>
          {step === 0 && <div className="mnTourWelcome">
            <div className="mnTourCopy">
              <span className="mnTourEyebrow"><i/> WELCOME TO MASENET</span>
              <h1>Your next favourite <em>movie or drama</em> is waiting.</h1>
              <p>Explore Asian dramas, movies and more in one beautifully connected entertainment space.</p>
              <div className="mnTourMiniStats"><span><Film size={14}/> Movies & dramas</span><span><Languages size={14}/> Subtitles when available</span></div>
            </div>
            <div className="mnTourStageWrap">
              <div className="mnTourStage" ref={stageRef} onMouseMove={tiltStage} onMouseLeave={() => {stageRef.current?.style.setProperty('--tilt-x','0deg');stageRef.current?.style.setProperty('--tilt-y','0deg');}}>
                <div className="mnTourStageAura"/>
                <div className="mnTourPoster mnTourPosterA"><span>ASIAN DRAMAS</span><b>Stories<br/>that stay.</b><i>✦</i></div>
                <div className="mnTourPoster mnTourPosterB"><span>4K MOVIES</span><b>Big screen<br/>feeling.</b><i>◈</i></div>
                <div className="mnTourPoster mnTourPosterC"><span>SUBTITLES & DUBS</span><b>Your language.<br/>Your choice.</b><i>CC</i></div>
                <div className="mnTourPoster mnTourPosterD"><span>OFFLINE DOWNLOADS</span><b>Take it<br/>with you.</b><i>↓</i></div>
              </div>
              <span className="mnTourStageCaption">DISCOVER · WATCH · SAVE</span>
            </div>
          </div>}
          {step === 1 && <div className="mnTourFeatures">
            <div className="mnTourHeading"><span className="mnTourEyebrow"><i/> MADE FOR YOUR WATCHLIST</span><h2>Everything you need to enjoy the story.</h2><p>Tap a feature to see how it works.</p></div>
            <div className="mnTourFeatureList">{featureCards.map((feature, index) => <article className={expandedFeature === index ? 'expanded' : ''} key={feature.title}>
              <button type="button" onClick={() => setExpandedFeature(current => current === index ? null : index)} aria-expanded={expandedFeature === index}>
                <span className="mnTourFeatureIcon">{feature.icon}</span><span className="mnTourFeatureText"><b>{feature.title}</b><small>{feature.copy}</small></span><span className="mnTourFeaturePlus">{expandedFeature === index ? '−' : '+'}</span>
              </button>
              {expandedFeature === index && <p className="mnTourFeatureDetail">{feature.detail}</p>}
            </article>)}</div>
          </div>}
          {step === 2 && <div className="mnTourGenres">
            <div className="mnTourHeading"><span className="mnTourEyebrow"><i/> YOUR TASTE, YOUR HOME</span><h2>What do you love watching?</h2><p>Pick as many genres as you like. You can change these preferences later.</p></div>
            <div className="mnTourGenreGrid">{genres.map((genre, index) => <button type="button" key={genre} onClick={() => toggleGenre(genre)} className={selectedGenres.includes(genre) ? 'selected' : ''} aria-pressed={selectedGenres.includes(genre)} style={{'--genre-index': index} as CSSProperties}><span>{['◈','⚡','♡','武','⌕','✦'][index]}</span>{genre}{selectedGenres.includes(genre) && <Check size={15}/>}</button>)}</div>
            <small className="mnTourSavedNote">Your choices save on this device automatically.</small>
          </div>}
          {step === 3 && <div className="mnTourReady">
            <canvas className="mnTourConfetti" ref={canvasRef} aria-hidden="true"/>
            <div className="mnTourCheck"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28"/><path d="m18 33 9 9 20-21"/></svg></div>
            <span className="mnTourEyebrow"><i/> YOU'RE ALL SET</span>
            <h2>Ready when you are.</h2>
            <p>Your MaseNet experience is ready to explore.</p>
            <div className="mnTourSelected"><b>Your genres</b>{selectedGenres.length ? selectedGenres.map(genre => <span key={genre}>{genre}</span>) : <small>No genres selected yet — you can personalise this anytime.</small>}</div>
            <div className="mnTourAuth">
              <div className="mnTourAuthTitle"><b>Sign in to MaseNet</b><small>Choose how you want to access your account.</small></div>
              <button type="button" className="mnTourAuthProvider mnTourGoogle" onClick={()=>void handleGoogle()} disabled={!!authBusy}><Chrome size={18}/><span>{authBusy==='google'?'Connecting…':'Continue with Google'}</span>{authBusy==='google'?<LoaderCircle size={16} className="mnTourSpin"/>:<ArrowRight size={16}/>}</button>
              <button type="button" className="mnTourAuthProvider mnTourTelegram" onClick={()=>void handleTelegram()} disabled={!!authBusy}><Bot size={18}/><span>{authBusy==='telegram'?'Connecting…':'Continue with Telegram'}</span>{authBusy==='telegram'?<LoaderCircle size={16} className="mnTourSpin"/>:<ArrowRight size={16}/>}</button>
              <div className="mnTourAuthDivider"><i/> <span>OR USE EMAIL</span> <i/></div>
              {emailStage==='email'?<form className="mnTourEmailForm" onSubmit={event=>{event.preventDefault();void sendEmailCode()}}><label htmlFor="mn-tour-email">Email address</label><div><Mail size={17}/><input id="mn-tour-email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" value={email} onChange={event=>setEmail(event.target.value)}/></div><button type="submit" disabled={emailBusy||!email.trim()}>{emailBusy?<><LoaderCircle size={16} className="mnTourSpin"/> Sending code…</>:<>Send email code <ArrowRight size={16}/></>}</button></form>:<form className="mnTourEmailForm" onSubmit={event=>{event.preventDefault();void verifyEmailCode()}}><label htmlFor="mn-tour-code">Six-digit verification code</label><div><Mail size={17}/><input id="mn-tour-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required placeholder="000000" value={otp} onChange={event=>setOtp(event.target.value.replace(/\\D/g,'').slice(0,6))}/></div><button type="submit" disabled={emailBusy||otp.length!==6}>{emailBusy?<><LoaderCircle size={16} className="mnTourSpin"/> Verifying…</>:<>Verify & sign in <ArrowRight size={16}/></>}</button><button type="button" className="mnTourEmailBack" onClick={()=>{setEmailStage('email');setOtp('');setEmailMessage('')}}>Use a different email</button></form>}
              {emailMessage&&<p className="mnTourAuthMessage" role="status">{emailMessage}</p>}
              <button type="button" className="mnTourReplay" onClick={replay}><RotateCcw size={15}/> Replay tour</button>
            </div>
          </div>}
        </div>
        <footer className="mnTourFooter">
          <button type="button" className="mnTourBack" onClick={previous} disabled={step === 0}><ArrowLeft size={15}/> Back</button>
          <span>{String(step + 1).padStart(2,'0')} <i>/ 04</i></span>
          {step < 3 ? <button type="button" className="mnTourNext" onClick={next}>Continue <ArrowRight size={15}/></button> : <button type="button" className="mnTourDone" onClick={close}>Done <Check size={15}/></button>}
        </footer>
      </section>
    </div>}
  </>;
}
