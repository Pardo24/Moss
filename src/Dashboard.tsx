import { useState } from 'react';
import { Home, Lock, Globe, Settings } from 'lucide-react';
import { useT } from './LangContext';
import type { Lang } from './i18n';
import appIcon from '../assets/icons/icons/png/64x64.png';
import PageHome from './pages/PageHome';
import PageVpn from './pages/PageVpn';
import PageNetwork from './pages/PageNetwork';
import PageSettings from './pages/PageSettings';

type Page = 'home' | 'vpn' | 'network' | 'settings';

const LANGS: { code: Lang; label: string }[] = [
  { code: 'ca', label: 'CA' },
  { code: 'es', label: 'ES' },
  { code: 'en', label: 'EN' },
];

type Props = {
  initialConfig: Record<string, string>;
  onReinstall: () => void;
};

export default function Dashboard({ initialConfig, onReinstall }: Props) {
  const { t, lang, setLang } = useT();
  const [page, setPage] = useState<Page>('home');
  const [config, setConfig] = useState(initialConfig);

  const navItems: { id: Page; icon: React.ReactNode; label: string }[] = [
    { id: 'home',     icon: <Home     size={18} strokeWidth={1.75} />, label: t.nav_home },
    { id: 'vpn',      icon: <Lock     size={18} strokeWidth={1.75} />, label: t.nav_vpn },
    { id: 'network',  icon: <Globe    size={18} strokeWidth={1.75} />, label: t.nav_network },
    { id: 'settings', icon: <Settings size={18} strokeWidth={1.75} />, label: t.nav_settings },
  ];

  const refreshConfig = async () => {
    const cfg = await window.electron.getConfig();
    if (cfg) setConfig(cfg);
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sidebar */}
      <div className="sidebar w-20 flex flex-col items-center py-4 gap-0.5 shrink-0">
        {/* Logo mark */}
        <div className="mb-4 mt-1">
          <div className="logo-circle" style={{ width: 40, height: 40, borderRadius: 12, padding: 4, boxShadow: '0 4px 12px rgba(249,115,22,0.3)' }}>
            <img src={appIcon} alt="Caliu" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }} />
          </div>
        </div>

        {/* Nav items */}
        {navItems.map(item => (
          <button
            key={item.id}
            onClick={() => setPage(item.id)}
            className={`nav-btn ${page === item.id ? 'active' : ''}`}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}

        {/* Language selector */}
        <div className="mt-auto flex flex-col items-center gap-1 pb-3">
          {LANGS.map(({ code, label }) => (
            <button
              key={code}
              onClick={() => setLang(code)}
              className={`lang-btn ${lang === code ? 'active' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto" style={{ background: 'rgba(246,248,255,0.55)' }}>
        {page === 'home'     && <PageHome config={config} />}
        {page === 'vpn'      && <PageVpn config={config} onChanged={refreshConfig} />}
        {page === 'network'  && <PageNetwork config={config} />}
        {page === 'settings' && <PageSettings onReinstall={onReinstall} />}
      </div>
    </div>
  );
}
