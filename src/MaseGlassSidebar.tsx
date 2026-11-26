import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { House, Search, Film, Bookmark, Bell, UserRound, ChevronLeft, ChevronRight, Clapperboard, Menu, Settings2 } from 'lucide-react';

type Item = { label: string; icon: typeof House; action: () => void; tone?: string };

function clickCategory(pattern: RegExp) {
  const button = Array.from(document.querySelectorAll('.iqCategories button')).find(node => pattern.test(node.textContent || '')) as HTMLButtonElement | undefined;
  button?.click();
  document.getElementById('iq-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function MaseGlassSidebar() {
  const [route, setRoute] = useState(window.location.hash || '#/home');
  const [expanded, setExpanded] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(64);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unread, setUnread] = useState('');
  const [liveVisitors, setLiveVisitors] = useState<number | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const syncRoute = () => setRoute(window.location.hash || '#/home');
    const syncUnread = () => setUnread(document.querySelector('.dockNotificationBadge')?.textContent?.trim() || '');
    const syncLiveVisitors = async () => { try { const response = await fetch('/api/presence', { cache: 'no-store', credentials: 'same-origin' }); if (response.ok) { const data = await response.json() as { online?: number }; if (Number.isFinite(data.online)) setLiveVisitors(Math.max(0, Number(data.online))); } } catch { /* Live count stays unavailable rather than showing a made-up number. */ } };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '[' || event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement | null)?.tagName || '')) return;
      if (window.matchMedia('(max-width: 760px)').matches) return;
      event.preventDefault();
      setExpanded(value => { const next = !value; setSidebarWidth(next ? 256 : 64); return next; });
    };
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('keydown', onKey);
    const observer = new MutationObserver(syncUnread);
    if (document.body) observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    syncUnread();
    void syncLiveVisitors();
    const liveTimer = window.setInterval(() => void syncLiveVisitors(), 30000);
    return () => {
      window.removeEventListener('hashchange', syncRoute);
      window.removeEventListener('keydown', onKey);
      window.clearInterval(liveTimer);
      observer.disconnect();
    };
  }, []);

  if (route.startsWith('#/admin') || route.startsWith('#/episode/')) return null;

  const invoke = (action: () => void) => { action(); setDrawerOpen(false); };
  const toggleSidebar = () => {
    if (dragged.current) { dragged.current = false; return; }
    if (window.matchMedia('(max-width: 760px)').matches) { setDrawerOpen(value => !value); return; }
    setExpanded(value => { const next = !value; setSidebarWidth(next ? 256 : 64); return next; });
  };
  const items: Item[] = [
    { label: 'Home', icon: House, action: () => { window.location.hash = '#/home'; }, tone: 'home' },
    { label: 'Search', icon: Search, action: () => { (document.querySelector('.maseSearchToggle') as HTMLButtonElement | null)?.click(); }, tone: 'search' },
    { label: 'Movies', icon: Clapperboard, action: () => clickCategory(/^movies$/i), tone: 'movies' },
    { label: 'Chinese Drama', icon: Film, action: () => clickCategory(/chinese drama|drama/i), tone: 'drama' },
    { label: 'Watchlist', icon: Bookmark, action: () => { window.location.hash = '#/my-list'; }, tone: 'watchlist' },
    { label: 'Alerts', icon: Bell, action: () => { (document.querySelector('.dockNotifications') as HTMLButtonElement | null)?.click(); }, tone: 'alerts' },
    { label: 'Profile', icon: UserRound, action: () => { (document.querySelector('.maseProfileButton') as HTMLButtonElement | null)?.click(); }, tone: 'profile' },
    { label: 'Settings', icon: Settings2, action: () => { window.dispatchEvent(new CustomEvent('masenet:open-settings')); }, tone: 'settings' }
  ];
  const sidebarStyle = { '--mase-sidebar-width': `${sidebarWidth}px` } as CSSProperties;

  return <>
    <button type="button" className={`maseSidebarMobileTrigger ${drawerOpen ? 'isOpen' : ''}`} aria-label={drawerOpen ? "Close MaseNet navigation" : "Open MaseNet navigation"} aria-expanded={drawerOpen} onClick={() => setDrawerOpen(value => !value)}><span className="maseMenuMorphIcon"><Menu size={19}/></span></button>
    {drawerOpen && <button type="button" className="maseSidebarScrim" aria-label="Close navigation drawer" onClick={() => setDrawerOpen(false)} />}
    <button
      type="button"
      className="maseSidebarEdgeToggle"
      style={sidebarStyle}
      aria-label={drawerOpen ? 'Close navigation' : expanded ? 'Collapse navigation' : 'Expand navigation'}
      title="Toggle sidebar · ["
      onClick={toggleSidebar}
      onPointerDown={event => { if (window.matchMedia('(max-width: 760px)').matches) return; drag.current = { x: event.clientX, width: sidebarWidth }; dragged.current = false; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={event => { if (!drag.current || !(event.buttons & 1)) return; const next = Math.max(64, Math.min(320, drag.current.width + event.clientX - drag.current.x)); if (Math.abs(next - drag.current.width) > 5) dragged.current = true; setSidebarWidth(next); setExpanded(next > 104); }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      {drawerOpen || expanded ? <ChevronLeft size={18}/> : <ChevronRight size={18}/>}
    </button>
    <aside className={`maseGlassSidebar ${expanded ? 'isExpanded' : ''} ${drawerOpen ? 'isDrawerOpen' : ''}`} style={sidebarStyle} aria-label="MaseNet navigation">
      <div className="maseSidebarBrand"><img src="/masenet-app-icon.svg" alt=""/><span><b>MaseMediaTv</b><small>STREAMING LIBRARY</small></span></div>
      <div className="maseSidebarSectionLabel">DISCOVER</div>
      <nav className="maseSidebarItems">
        {items.map(({ label, icon: Icon, action, tone }) => <button type="button" key={label} className={`maseSidebarItem tone-${tone} ${label === 'Home' && route === '#/home' ? 'isActive' : ''}`} onClick={() => invoke(action)} title={expanded || drawerOpen ? undefined : label}>
          <span className="maseSidebarIcon"><Icon size={19}/></span><span className="maseSidebarLabel">{label}</span>
          {label === 'Alerts' && unread && <i className="maseSidebarCount">{unread}</i>}
          {label === 'Movies' && <i className="maseSidebarCollectionDot dot-gold"/>}
          {label === 'Chinese Drama' && <i className="maseSidebarCollectionDot dot-emerald"/>}
        </button>)}
      </nav>
      <section className="maseSidebarVip maseSidebarLive" aria-label="People currently using MaseNet">
        <span className="maseSidebarVipMark"><i className="maseLiveDot"/></span>
        <span className="maseSidebarVipCopy"><b>LIVE NOW <i>{liveVisitors === null ? '—' : liveVisitors.toLocaleString()}</i></b><small>USING MASENET</small></span>
      </section>
      <button type="button" className="maseSidebarProfileFooter" onClick={() => invoke(items[6].action)}>
        <span className="maseSidebarAvatar"><UserRound size={17}/></span><span className="maseSidebarProfileText"><b>Your profile</b><small>Personalise MaseNet</small></span><ChevronRight size={15}/>
      </button>
    </aside>
  </>;
}
