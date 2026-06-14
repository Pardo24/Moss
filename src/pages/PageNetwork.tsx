import { useState, useEffect } from 'react';
import { Wifi, Globe, Copy, Check, ExternalLink, Cast, ShieldCheck, Loader2, Power } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useT } from '../LangContext';
import type { TailscaleState } from '../lib/transport';
import ServiceIcon, { type ServiceName } from '../components/ServiceIcon';
import PageVpn from './PageVpn';

const SERVICES: { name: ServiceName; port: number }[] = [
  { name: 'Jellyfin',    port: 8096 },
  { name: 'Jellyseerr',  port: 5055 },
  { name: 'qBittorrent', port: 8090 },
  { name: 'Radarr',      port: 7878 },
  { name: 'Sonarr',      port: 8989 },
  { name: 'Bazarr',      port: 6767 },
  { name: 'Prowlarr',    port: 9696 },
];

type Tab = 'local' | 'remote' | 'vpn';
type Props = { config: Record<string, string>; onChanged: () => void; scrollToVpn?: boolean };

// Remote access via Tailscale (private mesh; exposes only Jellyfin). Reuses the
// same backend as the wizard's StepTailscale: status on mount, enable → QR login
// → connected, plus a disable button (logout) the wizard doesn't need.
function RemoteTab() {
  const { t } = useT();
  const [st, setSt] = useState<TailscaleState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.electron.tailscaleStatus().then(setSt).catch(() => { /* ignore */ });
    window.electron.onTailscaleProgress(setSt);
  }, []);

  // Poll while connecting in case an SSE event is dropped.
  useEffect(() => {
    if (!busy) return;
    if (st && (st.stage === 'connected' || st.stage === 'failed')) return;
    const id = setInterval(() => window.electron.tailscaleStatus().then(setSt).catch(() => { /* ignore */ }), 4000);
    return () => clearInterval(id);
  }, [busy, st]);

  const enable = async () => {
    setBusy(true);
    const r = await window.electron.tailscaleUp();
    if (r && 'stage' in r && r.stage) setSt(r as TailscaleState);
  };
  const disable = async () => {
    await window.electron.tailscaleDown();
    setSt({ running: false, stage: 'idle', loginUrl: '', accessUrl: '', error: '' });
    setBusy(false);
  };
  const copy = (text: string) => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 11, flexShrink: 0,
          background: 'rgba(99,102,241,0.09)', border: '1.5px solid rgba(99,102,241,0.18)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6366f1',
        }}>
          <Globe size={18} strokeWidth={1.75} />
        </div>
        <div>
          <p style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)' }}>{t.net_external_title}</p>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginTop: 1 }}>Tailscale</p>
        </div>
      </div>

      {st && st.stage === 'connected' ? (
        st.accessUrl ? (
          <>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-2)' }}>{t.tailscale_connected_desc}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'rgba(13,148,136,0.06)', border: '1px solid rgba(13,148,136,0.2)' }}>
              <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.accessUrl}</span>
              <button onClick={() => copy(st.accessUrl)} className="btn-secondary" style={{ padding: '5px 9px' }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
              <button onClick={() => window.electron.openExternal(st.accessUrl)} className="btn-secondary" style={{ padding: '5px 9px' }}><ExternalLink size={13} /></button>
            </div>
          </>
        ) : (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-2)' }}>{t.tailscale_certs_hint}</p>
        )
      ) : st && st.loginUrl ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ background: '#fff', padding: 12, borderRadius: 14, border: '1px solid var(--border)' }}><QRCodeSVG value={st.loginUrl} size={160} /></div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-3)', textAlign: 'center' }}>{t.tailscale_scan_desc}</p>
          <button onClick={() => window.electron.openExternal(st.loginUrl)} className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}><ExternalLink size={13} />{t.tailscale_open_link}</button>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={12} className="animate-spin" />{t.tailscale_waiting}</p>
        </div>
      ) : (
        <>
          <p style={{ fontSize: '0.82rem', lineHeight: 1.65, color: 'var(--text-2)' }}>{t.tailscale_sub}</p>
          <button onClick={enable} disabled={busy} className="btn-primary" style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}{t.tailscale_activate}
          </button>
        </>
      )}

      {st && st.stage === 'connected' && (
        <button onClick={disable} className="btn-secondary" style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: '#ef4444' }}>
          <Power size={13} />{t.tailscale_disable}
        </button>
      )}
    </div>
  );
}

export default function PageNetwork({ config, onChanged, scrollToVpn }: Props) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>(scrollToVpn ? 'vpn' : 'local');
  const [ip, setIp] = useState('...');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    window.electron.getLocalIp().then((addr: string) => setIp(addr));
  }, []);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 1500);
  };

  function ServiceCard({ name, port }: { name: ServiceName; port: number }) {
    const url = `http://${ip}:${port}`;
    const isCopied = copied === name;
    return (
      <div className="card-sm" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ServiceIcon name={name} size={16} />
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)' }}>{name}</span>
        </div>
        <span style={{
          fontFamily: 'monospace', fontSize: '0.62rem', color: 'var(--text-3)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {`http://${ip}:${port}`}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => copy(url, name)}
            className="btn-ghost"
            style={{ flex: 1, fontSize: '0.68rem', padding: '3px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}
          >
            {isCopied ? <><Check size={10} />{t.net_copied}</> : <><Copy size={10} />URL</>}
          </button>
          <button
            onClick={() => window.electron.openExternal(url)}
            className="btn-ghost"
            style={{ flex: 1, fontSize: '0.68rem', padding: '3px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}
          >
            <ExternalLink size={10} />{t.net_open}
          </button>
        </div>
      </div>
    );
  }

  const TABS: { id: Tab; label: string; Icon: React.ComponentType<{ size: number; strokeWidth: number }> }[] = [
    { id: 'local',  label: t.net_local_title,    Icon: Wifi },
    { id: 'remote', label: t.net_external_title,  Icon: Globe },
    { id: 'vpn',    label: 'VPN',                 Icon: ShieldCheck },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Tab bar ───────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', padding: '0 16px', gap: 2, flexShrink: 0,
        borderBottom: '1px solid var(--border)',
      }}>
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '10px 12px', marginBottom: -1,
              fontSize: '0.8rem', fontWeight: tab === id ? 700 : 500,
              color: tab === id ? 'var(--accent)' : 'var(--text-3)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
              transition: 'color 0.15s', whiteSpace: 'nowrap',
            }}
          >
            <Icon size={13} strokeWidth={tab === id ? 2.5 : 2} />
            {label}
          </button>
        ))}
      </div>

      {/* ── Content ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* Local */}
        {tab === 'local' && (
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* IP row */}
            <div className="card-sm" style={{ padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Wifi size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-3)', fontWeight: 600 }}>{t.net_ip_label}</span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.88rem', fontWeight: 700, flex: 1, color: 'var(--accent)' }}>{ip}</span>
              <button
                onClick={() => copy(ip, 'ip')}
                className="btn-ghost"
                style={{ padding: '3px 8px', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                {copied === 'ip' ? <><Check size={11} />{t.net_copied}</> : <><Copy size={11} />{t.net_copy}</>}
              </button>
            </div>

            {/* Service cards grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {SERVICES.map(s => <ServiceCard key={s.name} {...s} />)}
            </div>

            {/* Chromecast tip */}
            <div style={{
              background: 'rgba(13,148,136,0.05)', border: '1px solid rgba(13,148,136,0.14)',
              borderRadius: 10, padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 9,
            }}>
              <Cast size={14} strokeWidth={2} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
              <p style={{ fontSize: '0.75rem', lineHeight: 1.55, color: 'var(--text-2)' }}>{t.net_chromecast_tip}</p>
            </div>

          </div>
        )}

        {/* Remote */}
        {tab === 'remote' && <RemoteTab />}

        {/* VPN */}
        {tab === 'vpn' && (
          <PageVpn config={config} onChanged={onChanged} />
        )}

      </div>
    </div>
  );
}