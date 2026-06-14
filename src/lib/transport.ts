/**
 * Transport polyfill for headless mode (Gecko OS kiosk).
 *
 * In desktop Electron, `window.electron` is set by src/preload.ts via
 * contextBridge. In Gecko OS the UI runs inside Chromium kiosk pointing at
 * http://localhost:3000 — no preload exists. This module detects that case
 * and installs an HTTP-backed shim with the same surface, so the rest of
 * the React tree doesn't care which transport is active.
 *
 * Each method maps to:
 *   - Desktop: ipcRenderer.invoke(<handler>, args)   (handled by preload)
 *   - Headless: fetch('/api/<handler>', POST args)   (handled by server.ts)
 *
 * Progress events use Server-Sent Events at /api/events.
 */

type ProgressCallback = (step: number) => void;

export interface Capabilities {
  wifi: boolean;            // nmcli available — show the WiFi wizard step
  installToDisk: boolean;   // parted+dd available — show the install-to-disk step
  nativeDialog: boolean;    // native folder picker (Electron-only)
}

export interface WifiNetwork {
  ssid: string;
  signal: number;           // 0-100
  secured: boolean;
}

export interface DiskInfo {
  name: string;             // /dev/nvme0n1
  size: string;             // "256 GB"
  model: string;            // "Samsung SSD 970 EVO Plus"
  rotational: boolean;
}

export interface PreflightCheck {
  id: 'ram' | 'cpu' | 'disk' | 'network';
  ok: boolean;
  detail: string;       // "16 GB" — what the user has
  threshold: string;    // "≥ 4 GB" — what's expected
}

export interface InstallToDiskState {
  running: boolean;
  stage: 'idle' | 'cloning' | 'reuuid' | 'grub' | 'rebooting' | 'failed';
  progress: number;         // 0-100
  bytesCopied: number;
  totalBytes: number;
  error: string;
}

export interface TailscaleState {
  running: boolean;
  stage: 'idle' | 'starting' | 'waiting-login' | 'serving' | 'connected' | 'failed';
  loginUrl: string;         // https://login.tailscale.com/... (shown as link + QR)
  accessUrl: string;        // https://gecko.<tailnet>.ts.net once serving Jellyfin
  error: string;            // hint when logged in but serve failed (enable HTTPS certs)
}

interface ElectronAPI {
  checkDocker:       () => Promise<string>;
  startDocker:       () => Promise<void>;
  pickFolder:        () => Promise<string | null>;
  install:           (config: unknown) => Promise<{ failedSteps: Array<{ step: number; error: string }>; skips?: string[] }>;
  addVpn:            (creds: unknown) => Promise<void>;
  removeVpn:         () => Promise<void>;
  getConfig:         () => Promise<Record<string, string> | null>;
  getStatus:         () => Promise<string>;
  startStack:        () => Promise<void>;
  stopStack:         () => Promise<void>;
  getLocalIp:        () => Promise<string>;
  resetInstall:      () => Promise<void>;
  openExternal:      (url: string) => Promise<void>;
  getVersion:        () => Promise<string>;
  getDiskStats:      (path: string) => Promise<{ freeBytes: number; totalBytes: number } | null>;
  getMediaList:      () => Promise<unknown[]>;
  deleteMedia:       (args: unknown) => Promise<void>;
  onInstallProgress: (cb: ProgressCallback) => void;
  preflight:         () => Promise<{ checks: PreflightCheck[] }>;
  // Kiosk-context (Gecko OS) — may return no-op values in desktop Electron
  capabilities:      () => Promise<Capabilities>;
  wifiScan:          () => Promise<WifiNetwork[]>;
  wifiConnect:       (args: { ssid: string; password?: string }) => Promise<{ ok: boolean; error?: string }>;
  wifiStatus:        () => Promise<{ connected: boolean; wifi: string | null; ethernet: string | null }>;
  // Install-to-disk (Gecko OS only) — dashboard action, not wizard
  disksList:           () => Promise<{ source: string; candidates: DiskInfo[] }>;
  installToDisk:       (args: { target: string; confirm: string }) => Promise<{ ok: boolean; error?: string }>;
  installToDiskStatus: () => Promise<InstallToDiskState>;
  onInstallToDiskProgress: (cb: (s: InstallToDiskState) => void) => void;
  // Tailscale remote access (private mesh; exposes only Jellyfin)
  tailscaleUp:         () => Promise<{ ok: boolean; started?: boolean } & Partial<TailscaleState>>;
  tailscaleStatus:     () => Promise<TailscaleState>;
  tailscaleDown:       () => Promise<void>;
  onTailscaleProgress: (cb: (s: TailscaleState) => void) => void;
}

declare global {
  interface Window { electron?: ElectronAPI }
}

// pick-folder isn't meaningful in a browser kiosk — there's no native dialog
// to open. Gecko OS handles folder choice via a different UI (lsblk-based
// list of mountpoints / disks). For now this just returns null, so the
// existing wizard's `pickFolder()` callsite falls through to text input.
async function pickFolderHeadless(): Promise<string | null> {
  return null;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  // 204 No Content → undefined; otherwise parse JSON
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function buildHttpShim(): ElectronAPI {
  const call = <T>(name: string, args?: unknown) => postJson<T>(`/api/${name}`, args);
  return {
    checkDocker:       () => call('check-docker'),
    startDocker:       () => call('start-docker'),
    pickFolder:        pickFolderHeadless,
    install:           (config) => call('install', config),
    addVpn:            (creds)  => call('add-vpn', creds),
    removeVpn:         () => call('remove-vpn'),
    getConfig:         () => call('get-config'),
    getStatus:         () => call('get-status'),
    startStack:        () => call('start-stack'),
    stopStack:         () => call('stop-stack'),
    getLocalIp:        () => call('get-local-ip'),
    resetInstall:      () => call('reset-install'),
    openExternal:      (url) => call('open-external', { url }),
    getVersion:        () => call('get-version'),
    getDiskStats:      (p)    => call('get-disk-stats', { path: p }),
    getMediaList:      () => call('get-media-list'),
    deleteMedia:       (args) => call('delete-media', args),
    onInstallProgress: (cb: ProgressCallback) => {
      const ev = new EventSource('/api/events');
      ev.addEventListener('install-progress', (e) => {
        const data = JSON.parse((e as MessageEvent).data);
        cb(data.step);
      });
    },
    preflight:         () => call('preflight'),
    capabilities:      () => call('capabilities'),
    wifiScan:          () => call('wifi-scan'),
    wifiConnect:       (args) => call('wifi-connect', args),
    wifiStatus:        () => call('wifi-status'),
    disksList:           () => call('disks-list'),
    installToDisk:       (args) => call('install-to-disk', args),
    installToDiskStatus: () => call('install-to-disk-status'),
    onInstallToDiskProgress: (cb) => {
      const ev = new EventSource('/api/events');
      ev.addEventListener('install-to-disk-progress', (e) => {
        cb(JSON.parse((e as MessageEvent).data));
      });
    },
    tailscaleUp:         () => call('tailscale-up'),
    tailscaleStatus:     () => call('tailscale-status'),
    tailscaleDown:       () => call('tailscale-down'),
    onTailscaleProgress: (cb) => {
      const ev = new EventSource('/api/events');
      ev.addEventListener('tailscale-progress', (e) => {
        cb(JSON.parse((e as MessageEvent).data));
      });
    },
  };
}

/**
 * Install the HTTP shim into `window.electron` if not already present.
 * Call this once, before React mounts.
 */
export function installTransport(): void {
  if (typeof window === 'undefined') return;       // SSR safety, not used today
  if (window.electron) return;                     // desktop Electron already set this
  window.electron = buildHttpShim();
}
