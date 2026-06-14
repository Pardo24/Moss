/**
 * Gecko UI server — the single entry point for the user interface.
 *
 * Serves the built React bundle as a static site and exposes the install
 * + management API as POST /api/<handler> endpoints. The browser-side
 * code in src/lib/transport.ts wraps these so React components keep
 * calling `window.electron.foo()` (historical name) and don't care
 * whether they're in a Chromium kiosk, a user's browser, or anything else.
 *
 * Used by:
 *   - Gecko OS appliance (runs in Chromium kiosk on the device)
 *   - Windows installer (runs as a Windows service, opens default browser)
 *   - macOS installer (runs as a launchd agent, opens default browser)
 *
 * Run in dev:  npm run start:dev    (vite + tsx watch)
 * Run prod:    npm run start        (after npm run build)
 */

import express from 'express';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { runAutoSetup } from './autoSetup';
import { seedDockerVolumes } from './lib/seedVolumes';

const execAsync = promisify(exec);

const PORT = Number(process.env.PORT ?? 3000);
// Where the built React UI lives. The installer sets STATIC_DIR explicitly;
// otherwise locate it: dev/local builds put it at <root>/dist (Vite), and the
// packaged app copies it next to the server bundle under ./renderer. The old
// default ('renderer/main_window', an Electron Forge Webpack path) no longer
// exists and caused ENOENT on index.html.
const STATIC_DIR = (() => {
  if (process.env.STATIC_DIR) return process.env.STATIC_DIR;
  const distDir = path.join(__dirname, '..', 'dist');       // dev (src/) or local bundle (dist-server/) → <root>/dist
  if (existsSync(path.join(distDir, 'index.html'))) return distDir;
  const rendererDir = path.join(__dirname, 'renderer');     // installed fallback (see installer/windows/gecko.nsi)
  if (existsSync(path.join(rendererDir, 'index.html'))) return rendererDir;
  return distDir;
})();
const COMPOSE_DIR = process.env.COMPOSE_DIR ?? path.join(os.homedir(), '.gecko', 'stack');
const STACK_BASE = process.env.STACK_BASE ?? path.join(__dirname, '..', '..', 'stack');
// __GECKO_VERSION__ is replaced at build time (esbuild --define, fed from
// package.json by scripts/build-server.mjs). The env var still wins so a
// host launcher can override it; the baked value covers Gecko OS, where
// nothing sets GECKO_VERSION. The typeof guard keeps `tsx` dev mode (no
// --define) from throwing a ReferenceError.
declare const __GECKO_VERSION__: string;
const PKG_VERSION = process.env.GECKO_VERSION
  ?? (typeof __GECKO_VERSION__ !== 'undefined' ? __GECKO_VERSION__ : '0.0.0-dev');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Event bus for install progress (replaces IPC `install-progress` push) ─
const events = new EventEmitter();
events.setMaxListeners(50);  // SSE clients can pile up briefly during reloads

// ── Helpers (mirrored from main.ts, no Electron deps) ─────────────────
function dockerEnv() {
  const base = process.env.PATH ?? '';
  if (process.platform === 'darwin') {
    return { ...process.env, PATH: `${base}:/usr/local/bin:/opt/homebrew/bin:/usr/bin` };
  }
  // Linux (Gecko OS) — Docker is at /usr/bin/docker
  return { ...process.env };
}

function parseEnv(content: string): Record<string, string> {
  return Object.fromEntries(
    content.split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => {
        const idx = l.indexOf('=');
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      }),
  );
}

// ── API handlers ──────────────────────────────────────────────────────
// All handlers are POST so we can pass JSON bodies uniformly. 204 = void.

app.post('/api/get-version', (_req, res) => res.json(PKG_VERSION));

app.post('/api/check-docker', async (_req, res) => {
  try { await execAsync('docker info', { env: dockerEnv() }); return res.json('running'); }
  catch {
    try { await execAsync('docker --version', { env: dockerEnv() }); return res.json('installed'); }
    catch { return res.json('missing'); }
  }
});

app.post('/api/start-docker', async (_req, res) => {
  // On Gecko OS, Docker is a systemd service. The wizard doesn't normally
  // hit this path (docker is enabled at image-build time), but support it
  // for resilience.
  try { await execAsync('systemctl start docker', { env: dockerEnv() }); } catch { /* best-effort */ }
  res.status(204).end();
});

app.post('/api/pick-folder', (_req, res) => res.json(null));   // no native dialog in kiosk

app.post('/api/get-local-ip', (_req, res) => {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return res.json(iface.address);
    }
  }
  res.json('127.0.0.1');
});

app.post('/api/open-external', (_req, res) => {
  // Kiosk shouldn't open external browsers. In Gecko OS, this is intentionally
  // a no-op (Chromium kiosk has no URL bar). Could be wired to `xdg-open` later
  // if we add a "click to copy URL" affordance.
  res.status(204).end();
});

// ── Preflight — system info + warnings on welcome screen ─────────────
// Lightweight checks the wizard renders on the welcome step so the user
// knows up front whether their hardware is in spec.
app.post('/api/preflight', async (_req, res) => {
  // Total RAM in GB
  const ramGb = Math.round(os.totalmem() / 1e9 * 10) / 10;
  // CPU core count + arch
  const cpuCores = os.cpus().length;
  const arch = os.arch();
  // Free space on the OS root (proxy for "available now"). On Gecko OS that's
  // the rootfs ext4 (sized to the disk); on desktop installs it's C:/ or /
  // — meaningful as a sanity check, the user picks a separate DATA_PATH later.
  let freeGb = 0;
  try {
    const target = process.platform === 'win32' ? 'C:\\' : '/';
    // statfs is in fs/promises in Node 18+; cast to access
    const stats = await (fs as unknown as {
      statfs: (p: string) => Promise<{ bfree: number; bsize: number }>;
    }).statfs(target);
    freeGb = Math.round(stats.bfree * stats.bsize / 1e9);
  } catch { /* leave as 0; UI marks as "unknown" */ }

  const checks = [
    { id: 'ram',     ok: ramGb >= 4,        detail: `${ramGb} GB`,   threshold: '≥ 4 GB' },
    { id: 'cpu',     ok: cpuCores >= 2,     detail: `${cpuCores} cores · ${arch}`, threshold: '≥ 2 cores · x86_64' },
    { id: 'disk',    ok: freeGb >= 100,     detail: freeGb ? `${freeGb} GB free` : 'unknown', threshold: '≥ 100 GB' },
    { id: 'network', ok: true,              detail: 'reachable',     threshold: 'internet' },
  ];
  res.json({ checks });
});

// ── Capabilities probe — drives conditional wizard steps ─────────────
// The wizard pings this on mount and shows/hides steps based on what the
// host actually supports. WiFi on Gecko OS (nmcli available); install-to-
// disk on Gecko OS (parted+dd available); native folder picker on Electron.
app.post('/api/capabilities', async (_req, res) => {
  const has = async (cmd: string) => {
    try { await execAsync(`command -v ${cmd}`, { env: dockerEnv() }); return true; }
    catch { return false; }
  };
  res.json({
    wifi:           await has('nmcli'),
    installToDisk:  await has('parted') && await has('dd'),
    nativeDialog:   false,                            // headless never has one
  });
});

// ── WiFi (nmcli-backed; Gecko OS only) ───────────────────────────────
app.post('/api/wifi-scan', async (_req, res) => {
  try {
    // Force a rescan so we get fresh APs (otherwise nmcli returns stale cache)
    await execAsync('nmcli device wifi rescan', { env: dockerEnv() }).catch(() => undefined);
    const { stdout } = await execAsync(
      'nmcli -t -e no -f SSID,SIGNAL,SECURITY device wifi list',
      { env: dockerEnv() },
    );
    const seen = new Set<string>();
    const networks = stdout.trim().split('\n').filter(Boolean).flatMap(line => {
      const [ssid, signalStr, security] = line.split(':');
      if (!ssid || seen.has(ssid)) return [];
      seen.add(ssid);
      return [{
        ssid,
        signal: parseInt(signalStr, 10) || 0,
        secured: !!security && security !== '--',
      }];
    });
    // Strongest first
    networks.sort((a, b) => b.signal - a.signal);
    res.json(networks);
  } catch {
    res.json([]);
  }
});

app.post('/api/wifi-connect', async (req, res) => {
  const { ssid, password } = req.body ?? {};
  if (!ssid) return res.status(400).json({ ok: false, error: 'ssid required' });
  // nmcli quotes are tricky; spawn the safe way with exec + escaped args.
  // sudo prefix: /etc/sudoers.d/gecko-privileged grants NOPASSWD on nmcli.
  const escape = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd = password
    ? `sudo -n /usr/bin/nmcli device wifi connect ${escape(ssid)} password ${escape(password)}`
    : `sudo -n /usr/bin/nmcli device wifi connect ${escape(ssid)}`;
  try {
    await execAsync(cmd, { env: dockerEnv(), timeout: 30_000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Install-to-disk (Gecko OS only) ──────────────────────────────────
// One-shot operation: clone the running USB to an internal disk, fix UUIDs,
// reinstall GRUB, reboot. User-facing as a dashboard action (NOT a wizard
// step) so the user has already seen Gecko working on the USB before
// committing to a destructive disk wipe.
//
// All the destructive work lives in /usr/local/sbin/gecko-install-to-disk.sh
// (root-only). The server only invokes it via sudo and parses progress from
// its stdout — the helper writes progress as JSON lines, one per event.

interface DiskInfo { name: string; size: string; model: string; rotational: boolean; }
interface InstallToDiskState {
  running: boolean;
  stage: 'idle' | 'cloning' | 'reuuid' | 'grub' | 'rebooting' | 'failed';
  progress: number;
  bytesCopied: number;
  totalBytes: number;
  error: string;
}

const installToDiskState: InstallToDiskState = {
  running: false, stage: 'idle', progress: 0,
  bytesCopied: 0, totalBytes: 0, error: '',
};

app.post('/api/disks-list', async (_req, res) => {
  try {
    const { stdout: rootDev } = await execAsync('findmnt -no SOURCE /', { env: dockerEnv() });
    const source = rootDev.trim().replace(/p?\d+$/, '');     // /dev/sda3 → /dev/sda

    const { stdout: lsblkJson } = await execAsync(
      'lsblk -J -d -b -o NAME,SIZE,MODEL,ROTA,TYPE',
      { env: dockerEnv() },
    );
    interface LsblkDev { name: string; size: number; model: string; rota: string; type: string; }
    const parsed: { blockdevices: LsblkDev[] } = JSON.parse(lsblkJson);
    const fmtSize = (b: number) => {
      const g = b / 1e9;
      return g >= 1000 ? `${(g / 1000).toFixed(1)} TB` : `${Math.round(g)} GB`;
    };
    const candidates: DiskInfo[] = parsed.blockdevices
      .filter(d => d.type === 'disk' && `/dev/${d.name}` !== source && !d.name.startsWith('loop'))
      .map(d => ({
        name: `/dev/${d.name}`,
        size: fmtSize(d.size),
        model: (d.model || '').trim() || 'Unknown',
        rotational: d.rota === '1',
      }));
    res.json({ source, candidates });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/install-to-disk', async (req, res) => {
  const { target, confirm } = req.body ?? {};
  if (installToDiskState.running) return res.status(409).json({ error: 'already running' });
  if (!target || !confirm)        return res.status(400).json({ error: 'target and confirm required' });

  Object.assign(installToDiskState, {
    running: true, stage: 'cloning', progress: 0,
    bytesCopied: 0, totalBytes: 0, error: '',
  });
  res.json({ ok: true, started: true });

  // Spawn the privileged helper. It writes one JSON line per progress event
  // to stdout, terminating with stage=rebooting or stage=failed.
  const helper = exec(
    `sudo -n /usr/local/sbin/gecko-install-to-disk.sh ${JSON.stringify(target)} ${JSON.stringify(confirm)}`,
    { env: dockerEnv(), maxBuffer: 1024 * 1024 * 5 },
  );
  helper.stdout?.on('data', (chunk: string) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      try {
        const update = JSON.parse(line);
        Object.assign(installToDiskState, update);
        events.emit('install-to-disk-progress', { ...installToDiskState });
      } catch { /* non-JSON noise; skip */ }
    }
  });
  helper.on('exit', code => {
    if (code !== 0 && installToDiskState.stage !== 'rebooting') {
      installToDiskState.stage = 'failed';
      installToDiskState.error = installToDiskState.error || `helper exit ${code}`;
      events.emit('install-to-disk-progress', { ...installToDiskState });
    }
    installToDiskState.running = false;
  });
});

app.post('/api/install-to-disk-status', (_req, res) => res.json(installToDiskState));

// ── Tailscale remote access (private mesh; exposes ONLY Jellyfin) ─────
// Mirrors the install-to-disk async pattern: one job state, a start endpoint
// that captures the interactive login URL, and a status poll. The tailscale
// container ships with the stack but stays logged-out until the user enables
// remote access here. Never `tailscale funnel` — private tailnet only.
interface TailscaleState {
  running: boolean;
  stage: 'idle' | 'starting' | 'waiting-login' | 'serving' | 'connected' | 'failed';
  loginUrl: string;    // https://login.tailscale.com/... shown as link + QR
  accessUrl: string;   // https://gecko.<tailnet>.ts.net once serving Jellyfin
  error: string;       // hint when logged in but serve failed (e.g. enable HTTPS certs)
}
const tailscaleState: TailscaleState = {
  running: false, stage: 'idle', loginUrl: '', accessUrl: '', error: '',
};

const tsExec = (args: string) =>
  execAsync(`docker exec media_tailscale tailscale ${args}`, { env: dockerEnv() });

// Device's MagicDNS name from `tailscale status --json` → its https URL.
async function tailscaleAccessUrl(): Promise<string> {
  const { stdout } = await tsExec('status --json');
  const dns = String(JSON.parse(stdout)?.Self?.DNSName ?? '').replace(/\.$/, '');
  return dns ? `https://${dns}` : '';
}

app.post('/api/tailscale-up', async (_req, res) => {
  if (tailscaleState.stage === 'connected') return res.json({ ok: true, ...tailscaleState });
  if (tailscaleState.running)               return res.status(409).json({ error: 'already running' });

  Object.assign(tailscaleState, {
    running: true, stage: 'starting', loginUrl: '', accessUrl: '', error: '',
  });
  res.json({ ok: true, started: true });

  // Container ships idle/logged-out with the stack; make sure it's up.
  try { await execAsync('docker compose up -d tailscale', { cwd: COMPOSE_DIR, env: dockerEnv() }); }
  catch { /* may already be running */ }

  // `tailscale up` blocks until the user logs in, printing the auth URL first.
  // Spawn (don't await), scrape the URL, treat exit 0 as authenticated.
  // --accept-dns=false keeps Docker's DNS so media_jellyfin still resolves.
  const proc = exec('docker exec media_tailscale tailscale up --hostname=gecko --accept-dns=false',
                    { env: dockerEnv() });
  const scan = (chunk: string) => {
    const m = String(chunk).match(/https:\/\/login\.tailscale\.com\/\S+/);
    if (m && !tailscaleState.loginUrl) {
      tailscaleState.loginUrl = m[0];
      tailscaleState.stage = 'waiting-login';
      events.emit('tailscale-progress', { ...tailscaleState });
    }
  };
  proc.stdout?.on('data', scan);
  proc.stderr?.on('data', scan);   // tailscale prints the URL on stderr
  proc.on('exit', async code => {
    if (code === 0) {
      tailscaleState.stage = 'connected';   // device is on the tailnet
      try {
        // Expose ONLY Jellyfin over the private tailnet (HTTPS, MagicDNS).
        await tsExec('serve --bg --https=443 http://media_jellyfin:8096');
        tailscaleState.accessUrl = await tailscaleAccessUrl();
      } catch (err) {
        // Logged in but couldn't publish — usually: enable HTTPS Certificates
        // in the tailnet admin console. Surface the hint; device is still up.
        tailscaleState.error = err instanceof Error ? err.message : String(err);
      }
    } else {
      tailscaleState.stage = 'failed';
      tailscaleState.error = tailscaleState.error || `tailscale up exited ${code}`;
    }
    tailscaleState.running = false;
    events.emit('tailscale-progress', { ...tailscaleState });
  });
});

app.post('/api/tailscale-status', async (_req, res) => {
  // If idle, probe the container once — it may already be connected (e.g. after
  // a reboot) so the dashboard can show the access URL without re-auth.
  if (tailscaleState.stage === 'idle') {
    try {
      const { stdout } = await tsExec('status --json');
      if (JSON.parse(stdout)?.BackendState === 'Running') {
        tailscaleState.accessUrl = await tailscaleAccessUrl();
        tailscaleState.stage = 'connected';
      }
    } catch { /* container down or logged out */ }
  }
  res.json(tailscaleState);
});

app.post('/api/tailscale-down', async (_req, res) => {
  try { await tsExec('logout'); } catch { /* ignore */ }
  Object.assign(tailscaleState, { running: false, stage: 'idle', loginUrl: '', accessUrl: '', error: '' });
  res.status(204).end();
});

app.post('/api/wifi-status', async (_req, res) => {
  try {
    const { stdout } = await execAsync(
      "nmcli -t -f NAME,TYPE,DEVICE connection show --active",
      { env: dockerEnv() },
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    const wifi = lines.find(l => l.split(':')[1] === '802-11-wireless');
    const eth = lines.find(l => l.split(':')[1] === '802-3-ethernet');
    res.json({
      connected: !!(wifi || eth),
      wifi: wifi ? wifi.split(':')[0] : null,
      ethernet: eth ? eth.split(':')[0] : null,
    });
  } catch {
    // No nmcli (Electron desktop, or a Gecko OS that hasn't installed it)
    res.json({ connected: true, wifi: null, ethernet: null });
  }
});

app.post('/api/get-disk-stats', async (req, res) => {
  const { path: folderPath } = req.body ?? {};
  try {
    // statfs is in fs/promises in Node 18+; cast to access it
    const stats = await (fs as unknown as { statfs: (p: string) => Promise<{ bfree: number; bsize: number; blocks: number }> }).statfs(folderPath);
    res.json({
      freeBytes: stats.bfree * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    });
  } catch {
    res.json(null);
  }
});

app.post('/api/get-config', async (_req, res) => {
  try {
    const content = await fs.readFile(path.join(COMPOSE_DIR, '.env'), 'utf8');
    const cfg = parseEnv(content);
    res.json({ ...cfg, vpnEnabled: !!cfg.MULLVAD_PRIVATE_KEY });
  } catch {
    res.json(null);
  }
});

app.post('/api/get-status', async (_req, res) => {
  try {
    const { stdout } = await execAsync('docker compose ps -q', { cwd: COMPOSE_DIR, env: dockerEnv() });
    res.json(stdout.trim().split('\n').filter(Boolean).length > 0 ? 'running' : 'stopped');
  } catch {
    res.json('stopped');
  }
});

app.post('/api/start-stack', async (_req, res) => {
  await execAsync('docker compose up -d', { cwd: COMPOSE_DIR, env: dockerEnv() });
  res.status(204).end();
});

app.post('/api/stop-stack', async (_req, res) => {
  await execAsync('docker compose down', { cwd: COMPOSE_DIR, env: dockerEnv() });
  res.status(204).end();
});

app.post('/api/reset-install', async (_req, res) => {
  try { await execAsync('docker compose down --volumes', { cwd: COMPOSE_DIR, env: dockerEnv() }); } catch { /* ignore */ }
  await fs.rm(COMPOSE_DIR, { recursive: true, force: true });
  res.status(204).end();
});

app.post('/api/add-vpn', async (req, res) => {
  const { mullvadKey, mullvadAddress } = req.body ?? {};
  let env = await fs.readFile(path.join(COMPOSE_DIR, '.env'), 'utf8');
  env = env.replace(/^MULLVAD_PRIVATE_KEY=.*$/m, '').replace(/^MULLVAD_ADDRESSES=.*$/m, '').trim();
  env += `\nMULLVAD_PRIVATE_KEY=${mullvadKey}\nMULLVAD_ADDRESSES=${mullvadAddress}\n`;
  await fs.writeFile(path.join(COMPOSE_DIR, '.env'), env);
  await fs.copyFile(path.join(STACK_BASE, 'docker-compose.yml'),
                    path.join(COMPOSE_DIR, 'docker-compose.yml'));
  await execAsync('docker compose down', { cwd: COMPOSE_DIR, env: dockerEnv() });
  await execAsync('docker compose up -d', { cwd: COMPOSE_DIR, env: dockerEnv() });
  res.status(204).end();
});

app.post('/api/remove-vpn', async (_req, res) => {
  let env = await fs.readFile(path.join(COMPOSE_DIR, '.env'), 'utf8');
  env = env.replace(/^MULLVAD_PRIVATE_KEY=.*$/m, '')
           .replace(/^MULLVAD_ADDRESSES=.*$/m, '').trim() + '\n';
  await fs.writeFile(path.join(COMPOSE_DIR, '.env'), env);
  await fs.copyFile(path.join(STACK_BASE, 'docker-compose-novpn.yml'),
                    path.join(COMPOSE_DIR, 'docker-compose.yml'));
  await execAsync('docker compose down', { cwd: COMPOSE_DIR, env: dockerEnv() });
  await execAsync('docker compose up -d', { cwd: COMPOSE_DIR, env: dockerEnv() });
  res.status(204).end();
});

// ── Media list + delete (dashboard's Space Manager) ──────────────────
app.post('/api/get-media-list', async (_req, res) => {
  try {
    const content = await fs.readFile(path.join(COMPOSE_DIR, '.env'), 'utf8');
    const cfg = parseEnv(content);
    const { RADARR_API_KEY: radarrKey, SONARR_API_KEY: sonarrKey } = cfg;
    const radarrPort = cfg.RADARR_PORT ?? '7878';
    const sonarrPort = cfg.SONARR_PORT ?? '8989';

    const get = async (url: string, apiKey: string) => {
      const r = await fetch(url, { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return [];
      return r.json();
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [movies, series]: [any[], any[]] = await Promise.all([
      radarrKey ? get(`http://localhost:${radarrPort}/api/v3/movie`, radarrKey) : Promise.resolve([]),
      sonarrKey ? get(`http://localhost:${sonarrPort}/api/v3/series`, sonarrKey) : Promise.resolve([]),
    ]);

    res.json([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...movies.filter((m: any) => m.sizeOnDisk > 0).map((m: any) => ({
        id: m.id, title: m.title, year: m.year, type: 'movie', sizeOnDisk: m.sizeOnDisk,
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...series.filter((s: any) => (s.statistics?.sizeOnDisk ?? 0) > 0).map((s: any) => ({
        id: s.id, title: s.title, year: s.year, type: 'series',
        sizeOnDisk: s.statistics.sizeOnDisk,
      })),
    ].sort((a, b) => b.sizeOnDisk - a.sizeOnDisk));
  } catch {
    res.json([]);
  }
});

app.post('/api/delete-media', async (req, res) => {
  const { id, type, searchAfter } = req.body ?? {};
  const content = await fs.readFile(path.join(COMPOSE_DIR, '.env'), 'utf8');
  const cfg = parseEnv(content);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doFetch = async (url: string, method: string, apiKey: string, body?: any) => {
    const r = await fetch(url, {
      method,
      headers: { 'X-Api-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  };

  if (type === 'movie') {
    const key = cfg.RADARR_API_KEY;
    const base = `http://localhost:${cfg.RADARR_PORT ?? '7878'}`;
    if (searchAfter) {
      const movie = await (await doFetch(`${base}/api/v3/movie/${id}`, 'GET', key)).json();
      if (movie.movieFile?.id) await doFetch(`${base}/api/v3/movieFile/${movie.movieFile.id}`, 'DELETE', key);
      await doFetch(`${base}/api/v3/command`, 'POST', key, { name: 'MoviesSearch', movieIds: [id] });
    } else {
      await doFetch(`${base}/api/v3/movie/${id}?deleteFiles=true`, 'DELETE', key);
    }
  } else {
    const key = cfg.SONARR_API_KEY;
    const base = `http://localhost:${cfg.SONARR_PORT ?? '8989'}`;
    if (searchAfter) {
      const files = await (await doFetch(`${base}/api/v3/episodeFile?seriesId=${id}`, 'GET', key)).json();
      if (Array.isArray(files) && files.length > 0) {
        await fetch(`${base}/api/v3/episodeFile/bulk`, {
          method: 'DELETE',
          headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeFileIds: files.map((f: { id: number }) => f.id) }),
          signal: AbortSignal.timeout(15000),
        });
      }
      await doFetch(`${base}/api/v3/command`, 'POST', key, { name: 'SeriesSearch', seriesId: id });
    } else {
      await doFetch(`${base}/api/v3/series/${id}?deleteFiles=true`, 'DELETE', key);
    }
  }
  res.status(204).end();
});

app.post('/api/install', async (req, res) => {
  const config = req.body;
  const { dataPath, adminPassword, subtitleLangs, vpnEnabled, qualityDevice, qualityLang } = config;
  const progress = (step: number) => events.emit('install-progress', { step });

  // Step 0: dirs
  progress(0);
  const dirs = ['jellyfin/media/movies', 'jellyfin/media/series', 'jellyfin/media/music', 'downloads'];
  for (const d of dirs) await fs.mkdir(path.join(dataPath, d), { recursive: true });

  // Step 1: generate .env + compose
  progress(1);
  await fs.mkdir(COMPOSE_DIR, { recursive: true });
  const envLines = [
    `DATA_PATH=${dataPath.replace(/\\/g, '/')}`,
    `TZ=Europe/Madrid`,
    `JELLYFIN_PORT=8096`, `JELLYSEERR_PORT=5055`, `PROWLARR_PORT=9696`,
    `RADARR_PORT=7878`, `SONARR_PORT=8989`, `LIDARR_PORT=8686`,
    `BAZARR_PORT=6767`, `QBIT_PORT=8090`,
    `JELLYFIN_ADMIN_PASSWORD=${adminPassword}`,
    vpnEnabled ? `MULLVAD_PRIVATE_KEY=${config.mullvadKey}` : '',
    vpnEnabled ? `MULLVAD_ADDRESSES=${config.mullvadAddress}` : '',
  ].filter(Boolean).join('\n');
  await fs.writeFile(path.join(COMPOSE_DIR, '.env'), envLines);

  const composeFile = vpnEnabled ? 'docker-compose.yml' : 'docker-compose-novpn.yml';
  await fs.copyFile(path.join(STACK_BASE, composeFile), path.join(COMPOSE_DIR, 'docker-compose.yml'));
  await fs.cp(path.join(STACK_BASE, 'cleaner'), path.join(COMPOSE_DIR, 'cleaner'), { recursive: true });
  for (const sub of ['gecko-init', 'recyclarr', 'buildarr', 'seeds']) {
    try { await fs.cp(path.join(STACK_BASE, sub), path.join(COMPOSE_DIR, sub), { recursive: true }); }
    catch { /* not present */ }
  }

  // Step 1.5: seed Docker volumes from stack/seeds/ before any service
  // boots. Bazarr's language profiles can't be created via API so they
  // need to be in the SQLite before bazarr first reads it.
  const seedResult = await seedDockerVolumes(path.join(COMPOSE_DIR, 'seeds'), dockerEnv());
  console.log('[install] seeded volumes:', seedResult.seeded.join(', ') || '(none)');

  // Pre-create qBittorrent config with a known password (PBKDF2-HMAC-SHA512)
  // so we can log in reliably without scraping the docker logs for the
  // randomised temp password. The linuxserver/qbittorrent image reads this
  // file on first start; if absent it generates its own.
  const qbitConfigDir = path.join(dataPath, 'qbittorrent', 'qBittorrent');
  await fs.mkdir(qbitConfigDir, { recursive: true });
  const qbitSalt = crypto.randomBytes(16);
  const qbitKey: Buffer = await new Promise((resolve, reject) =>
    crypto.pbkdf2(adminPassword, qbitSalt, 100000, 64, 'sha512',
                  (err, k) => err ? reject(err) : resolve(k))
  );
  const qbitHash = `@ByteArray(${qbitSalt.toString('base64')}:${qbitKey.toString('base64')})`;
  await fs.writeFile(path.join(qbitConfigDir, 'qBittorrent.conf'), [
    '[Preferences]',
    'WebUI\\Username=admin',
    `WebUI\\Password_PBKDF2="${qbitHash}"`,
  ].join('\n'));

  // Step 2: pull + start
  progress(2);
  await execAsync('docker compose up -d --build', { cwd: COMPOSE_DIR, env: dockerEnv() });

  // Steps 3-7: auto-setup
  const result = await runAutoSetup({
    adminPassword,
    subtitleLangs: subtitleLangs ?? [],
    ports: {
      jellyfin: 8096, radarr: 7878, sonarr: 8989, lidarr: 8686,
      prowlarr: 9696, bazarr: 6767, qbit: 8090, jellyseerr: 5055,
    },
    vpnEnabled,
    qualityPrefs: { device: qualityDevice ?? 'modern', lang: qualityLang ?? 'original' },
    stackDir: COMPOSE_DIR,
    dockerEnvObj: dockerEnv(),
    onProgress: progress,
  });

  // Restart the cleaner so it picks up the freshly written API keys
  try {
    await execAsync('docker compose up -d --no-deps gecko-cleaner',
                    { cwd: COMPOSE_DIR, env: dockerEnv() });
  } catch (err) {
    console.warn('[install] gecko-cleaner restart failed:', err);
  }

  res.json({ failedSteps: result.failedSteps, skips: result.skips });
});

// SSE stream — clients subscribe and receive named events. Each named event
// is forwarded to the client when the server emits on the EventEmitter.
app.get('/api/events', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const NAMES = ['install-progress', 'install-to-disk-progress', 'tailscale-progress'] as const;
  const senders = NAMES.map(name => {
    const fn = (payload: unknown) => {
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    events.on(name, fn);
    return { name, fn };
  });
  // Heartbeat every 25 s to keep proxies from idle-closing the stream
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  _req.on('close', () => {
    for (const { name, fn } of senders) events.off(name, fn);
    clearInterval(heartbeat);
  });
});

// ── Static React bundle ───────────────────────────────────────────────
// Falls back to index.html for any unknown path → React router handles it.
app.use(express.static(STATIC_DIR));
app.get('*', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`[gecko-ui] listening on http://localhost:${PORT}`);
  console.log(`[gecko-ui]   static:  ${STATIC_DIR}`);
  console.log(`[gecko-ui]   compose: ${COMPOSE_DIR}`);
  console.log(`[gecko-ui]   stack:   ${STACK_BASE}`);
});
