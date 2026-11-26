import { useEffect, useRef, useState } from 'react';

type InstallChoice = { outcome: 'accepted' | 'dismissed'; platform: string };
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
};

export default function PWAInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [platform, setPlatform] = useState<'android' | 'ios' | 'other'>('other');
  const [canPrompt, setCanPrompt] = useState(false);
  const deferredPrompt = useRef<InstallPromptEvent | null>(null);

  useEffect(() => {
    const telegram = (window as Window & { Telegram?: { WebApp?: { initData?: string; platform?: string } } }).Telegram?.WebApp;
    if (telegram?.initData || (telegram?.platform && telegram.platform !== 'unknown')) return;

    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    if (standalone) return;

    const ua = navigator.userAgent;
    const detected = /Android/i.test(ua) ? 'android' : /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : 'other';
    setPlatform(detected);

    try {
      const dismissedAt = Number(localStorage.getItem('masenet-pwa-install-dismissed') || 0);
      if (dismissedAt && Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;
    } catch {}

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      deferredPrompt.current = event as InstallPromptEvent;
      setCanPrompt(true);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setHelpOpen(false);
      deferredPrompt.current = null;
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    if (detected === 'android' || detected === 'ios') {
      const showTimer = window.setTimeout(() => setVisible(true), 1800);
      return () => {
        window.clearTimeout(showTimer);
        window.removeEventListener('beforeinstallprompt', onBeforeInstall);
        window.removeEventListener('appinstalled', onInstalled);
      };
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    const event = deferredPrompt.current;
    if (event) {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === 'accepted') setVisible(false);
      deferredPrompt.current = null;
      setCanPrompt(false);
      return;
    }
    setHelpOpen(value => !value);
  };

  const dismiss = () => {
    setVisible(false);
    setHelpOpen(false);
    try { localStorage.setItem('masenet-pwa-install-dismissed', String(Date.now())); } catch {}
  };

  if (!visible) return null;

  return (
    <aside className="masePwaInstallBanner" aria-label="Install MaseNet app" style={{
      position: 'relative', zIndex: 1, right: 'auto', bottom: 'auto', left: 'auto', top: 'auto',
      width: 'min(480px, calc(100vw - 32px))', margin: '14px auto 24px', padding: '13px 14px',
      border: '1px solid rgba(56,230,160,.24)', borderRadius: 18,
      background: 'linear-gradient(125deg,rgba(19,43,30,.97),rgba(13,22,17,.97))', color: '#f1f8f4',
      boxShadow: '0 12px 32px rgba(0,0,0,.22)', backdropFilter: 'blur(14px)',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/masenet-app-icon.svg" alt="" width="38" height="38" style={{ borderRadius: 11, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ display: 'block', fontSize: 13 }}>Get the MaseNet app</strong>
          <span style={{ display: 'block', color: '#a9adbb', fontSize: 11, marginTop: 2 }}>Install it on your phone for quick access.</span>
        </div>
        <button type="button" aria-label="Dismiss install prompt" onClick={dismiss} style={{ border: 0, background: 'transparent', color: '#a9adbb', fontSize: 20, padding: '2px 5px' }}>×</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
        <button type="button" onClick={install} style={{ flex: 1, minHeight: 39, border: 0, borderRadius: 11, background: '#d2ad60', color: '#17120b', fontWeight: 800, fontSize: 12 }}>
          {canPrompt ? 'Install app' : 'How to install'}
        </button>
        <button type="button" onClick={dismiss} style={{ minHeight: 39, padding: '0 12px', border: '1px solid rgba(255,255,255,.12)', borderRadius: 11, background: 'rgba(255,255,255,.04)', color: '#c8cad2', fontSize: 12 }}>Later</button>
      </div>
      {helpOpen && <p style={{ margin: '10px 2px 0', color: '#c0c4cf', fontSize: 11, lineHeight: 1.5 }}>
        {platform === 'ios'
          ? 'In Safari, tap Share, then choose “Add to Home Screen”.'
          : platform === 'android'
            ? 'In Chrome, open the ⋮ menu and choose “Install app” or “Add to Home screen”.'
            : 'Use your browser menu and choose “Install MaseNet” or “Add to Home screen”.'}
      </p>}
    </aside>
  );
}
