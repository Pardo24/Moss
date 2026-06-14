import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Globe2, CheckCircle, XCircle, Loader2, Copy, Check, ExternalLink } from 'lucide-react';
import type { Config } from '../App';
import { useT } from '../LangContext';
import type { TailscaleState } from '../lib/transport';

type Props = { config: Config; updateConfig: (p: Partial<Config>) => void; next: () => void };

// Optional "remote access" step, shown after the stack is installed (so the
// tailscale container is up and `tailscale up` can run). Exposes ONLY Jellyfin
// over a private tailnet. Skippable.
export default function StepTailscale({ next }: Props) {
  const { t } = useT();
  const [started, setStarted] = useState(false);
  const [state, setState] = useState<TailscaleState | null>(null);
  const [copied, setCopied] = useState(false);

  const activate = async () => {
    setStarted(true);
    window.electron.onTailscaleProgress(setState);
    const r = await window.electron.tailscaleUp();
    if (r && 'stage' in r && r.stage) setState(r as TailscaleState);   // already connected
  };

  // Fallback polling in case an SSE event is dropped.
  useEffect(() => {
    if (!started) return;
    if (state && (state.stage === 'connected' || state.stage === 'failed')) return;
    const id = setInterval(async () => {
      try { setState(await window.electron.tailscaleStatus()); } catch { /* ignore */ }
    }, 4000);
    return () => clearInterval(id);
  }, [started, state]);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const stage = state?.stage;

  // ── Connected ─────────────────────────────────────────────────────
  if (stage === 'connected') {
    const url = state?.accessUrl;
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-6 px-8 text-center py-6">
        <CheckCircle size={72} style={{ color: 'var(--accent)' }} strokeWidth={1.5} />
        <h2 className="text-2xl font-bold">{t.tailscale_connected_title}</h2>
        {url ? (
          <>
            <p className="text-sm max-w-sm" style={{ color: 'var(--text-2)' }}>{t.tailscale_connected_desc}</p>
            <div className="w-full max-w-md flex items-center gap-2 p-3 rounded-lg"
                 style={{ background: 'rgba(13,148,136,0.06)', border: '1px solid rgba(13,148,136,0.2)' }}>
              <span className="flex-1 font-mono text-sm truncate text-left" style={{ color: 'var(--accent)' }}>{url}</span>
              <button onClick={() => copy(url)} className="btn-secondary" style={{ padding: '6px 10px' }}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button onClick={() => window.electron.openExternal(url)} className="btn-secondary" style={{ padding: '6px 10px' }}>
                <ExternalLink size={14} />
              </button>
            </div>
          </>
        ) : state?.error ? (
          <p className="text-sm max-w-md" style={{ color: 'var(--text-2)' }}>{t.tailscale_certs_hint}</p>
        ) : (
          <Loader2 size={28} className="animate-spin" style={{ color: 'var(--accent)' }} />
        )}
        <button onClick={next} className="btn-primary">{t.tailscale_continue}</button>
      </div>
    );
  }

  // ── Failed ────────────────────────────────────────────────────────
  if (stage === 'failed') {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-6 px-8 text-center py-6">
        <XCircle size={64} style={{ color: '#ef4444' }} strokeWidth={1.5} />
        <h2 className="text-2xl font-bold">{t.tailscale_failed_title}</h2>
        {state?.error && (
          <p className="font-mono text-xs max-w-md text-left break-all" style={{ color: '#ef4444' }}>{state.error}</p>
        )}
        <div className="flex gap-3">
          <button onClick={() => { setState(null); setStarted(false); }} className="btn-secondary">{t.tailscale_retry}</button>
          <button onClick={next} className="btn-primary">{t.tailscale_skip}</button>
        </div>
      </div>
    );
  }

  // ── Connecting / waiting for login ────────────────────────────────
  if (started) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-5 px-8 text-center py-6">
        {state?.loginUrl ? (
          <>
            <h2 className="text-2xl font-bold">{t.tailscale_scan_title}</h2>
            <div style={{ background: '#fff', padding: 14, borderRadius: 16, border: '1px solid var(--border)' }}>
              <QRCodeSVG value={state.loginUrl} size={188} />
            </div>
            <p className="text-sm max-w-sm" style={{ color: 'var(--text-3)' }}>{t.tailscale_scan_desc}</p>
            <button onClick={() => window.electron.openExternal(state.loginUrl)} className="btn-secondary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ExternalLink size={14} />{t.tailscale_open_link}
            </button>
            <p className="text-xs flex items-center gap-2" style={{ color: 'var(--text-3)' }}>
              <Loader2 size={13} className="animate-spin" />{t.tailscale_waiting}
            </p>
          </>
        ) : (
          <>
            <Loader2 size={48} className="animate-spin" style={{ color: 'var(--accent)' }} />
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>{t.tailscale_starting}</p>
          </>
        )}
      </div>
    );
  }

  // ── Intro (choose) ────────────────────────────────────────────────
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-6 px-8 text-center py-6">
      <div className="flex flex-col items-center gap-3">
        <div className="step-icon teal"><Globe2 size={38} strokeWidth={1.5} /></div>
        <div>
          <h2 className="text-2xl font-bold mb-1">{t.tailscale_title}</h2>
          <p className="text-sm max-w-md" style={{ color: 'var(--text-3)' }}>{t.tailscale_sub}</p>
        </div>
      </div>
      <p className="text-sm max-w-md" style={{ color: 'var(--text-2)' }}>{t.tailscale_what}</p>
      <div className="flex flex-col items-center gap-2">
        <button onClick={activate} className="btn-primary">{t.tailscale_activate}</button>
        <button onClick={next} className="text-xs underline" style={{ color: 'var(--text-3)' }}>{t.tailscale_skip}</button>
      </div>
    </div>
  );
}
