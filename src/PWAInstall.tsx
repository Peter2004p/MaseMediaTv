import { useEffect, useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';

type InstallChoice = { outcome: 'accepted' | 'dismissed'; platform?: string };
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
};

export default function PWAInstall() {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallEvent(null);
      setHelpOpen(false);
    };
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone) {
      setInstalled(true);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (installed) return;
    if (!installEvent) {
      setHelpOpen(value => !value);
      return;
    }
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      if (choice.outcome === 'accepted') setInstalled(true);
    } catch {
      setHelpOpen(true);
    } finally {
      setInstallEvent(null);
    }
  };

  if (installed) return <span className="maseInstallInstalled" title="MaseNet is installed"><Smartphone size={14} /> Installed</span>;

  return <div className="maseInstallWrap">
    <button type="button" className="maseInstallButton" onClick={() => void install()} aria-expanded={helpOpen} aria-label="Install MaseNet on this device">
      <Download size={15} /><span>Install</span>
    </button>
    {helpOpen && <div className="maseInstallHelp" role="status">
      <button type="button" className="maseInstallClose" aria-label="Close install instructions" onClick={() => setHelpOpen(false)}><X size={14} /></button>
      <b>Install MaseNet</b>
      <p>On Android, open your browser menu ⋮ and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>. If the option is missing, update Chrome and open this site over HTTPS.</p>
    </div>}
  </div>;
}
