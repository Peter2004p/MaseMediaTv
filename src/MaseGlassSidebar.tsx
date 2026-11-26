import { useEffect, useState } from 'react';
import { House, Search, Film, Bookmark, Bell, UserRound, ChevronLeft, ChevronRight, Clapperboard } from 'lucide-react';

type Item = { label: string; icon: typeof House; action: () => void; tone?: string };

function clickCategory(pattern: RegExp) {
  const button = Array.from(document.querySelectorAll('.iqCategories button')).find(node => pattern.test(node.textContent || '')) as HTMLButtonElement | undefined;
  button?.click();
  document.getElementById('iq-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function MaseGlassSidebar() {
  const [route, setRoute] = useState(window.location.hash || '#/home');
  const [expanded, setExpanded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unread, setUnread] = useState('');

  useEffect(() => {
    const syncRoute = () => setRoute(window.location.hash || '#/home');
    const syncUnread = () => setUnread(document.querySelector('.dockNotificationBadge')?.textContent?.trim() || '');
    window.addEventListener('hashchange', syncRoute);
    const observer = new MutationObserver(syncUnread);
    if (document.body) observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    syncUnread();
    return () => { window.removeEventListener('hashchange', syncRoute); observer.disconnect(); };
  }, []);

  if (route !== '#/home' && route !== '#/' && route !== '') return null;

  const invoke = (action: () => void) => { action(); setDrawerOpen(false); };
  const items: Item[] = [
    { label: 'Home', icon: House, action: () => { window.location.hash = '#/home'; }, tone: 'home' },
    { label: 'Search', icon: Search, action: () => { (document.querySelector('.maseSearchToggle') as HTMLButtonElement | null)?.click(); }, tone: 'search' },
    { label: 'Movies', icon: Clapperboard, action: () => clickCategory(/^movies$/i), tone: 'movies' },
    { label: 'Chinese Drama', icon: Film, action: () => clickCategory(/chinese drama|drama/i), tone: 'drama' },
    { label: 'Watchlist', icon: Bookmark, action: () => clickCategory(/my\s*list/i), tone: 'watchlist' },
    { label: 'Alerts', icon: Bell, action: () => { (document.querySelector('.dockNotifications') as HTMLButtonElement | null)?.click(); }, tone: 'alerts' },
    { label: 'Profile', icon: UserRound, action: () => { (document.querySelector('.maseProfileButton') as HTMLButtonElement | null)?.click(); }, tone: 'profile' }
  ];

  return <>
    {drawerOpen && <button type="button" className="maseSidebarScrim" aria-label="Close navigation drawer" onClick={() => setDrawerOpen(false)} />}
    <button type="button" className="maseSidebarEdgeToggle" aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'} onClick={() => { if (window.matchMedia('(max-width: 760px)').matches) setDrawerOpen(value => !value); else setExpanded(value => !value); }}>
      {drawerOpen || expanded ? <ChevronLeft size={18}/> : <ChevronRight size={18}/>}
    </button>
    <aside className={`maseGlassSidebar ${expanded ? 'isExpanded' : ''} ${drawerOpen ? 'isDrawerOpen' : ''}`} aria-label="MaseNet navigation">
      <div className="maseSidebarBrand"><img src="/masemediatv-logo.svg" alt=""/><span><b>MaseMediaTv</b><small>STREAMING LIBRARY</small></span></div>
      <div className="maseSidebarSectionLabel">DISCOVER</div>
      <nav className="maseSidebarItems">
        {items.map(({ label, icon: Icon, action, tone }) => <button type="button" key={label} className={`maseSidebarItem tone-${tone} ${label === 'Home' && route === '#/home' ? 'isActive' : ''}`} onClick={() => invoke(action)} title={expanded || drawerOpen ? undefined : label}>
          <span className="maseSidebarIcon"><Icon size={19}/></span><span className="maseSidebarLabel">{label}</span>
          {label === 'Alerts' && unread && <i className="maseSidebarCount">{unread}</i>}
        </button>)}
      </nav>
      <div className="maseSidebarFooter"><span className="maseSidebarLiveDot"/><span className="maseSidebarLabel">Your library, beautifully streamed</span></div>
    </aside>
  </>;
}
