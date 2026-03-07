import http from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Exponential backoff retry — recursive, up to maxAttempts times
// Delays between attempts: 1s, 2s, 4s, 8s (2^(attempt-1) seconds)
async function withRetry<T>(fn: () => Promise<T>, attempt = 1, maxAttempts = 5): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (attempt >= maxAttempts) throw err;
    await sleep(2 ** (attempt - 1) * 1000);
    return withRetry(fn, attempt + 1, maxAttempts);
  }
}

// ── HTTP primitives ──────────────────────────────────────────────

type Resp = { status: number; body: string; cookies: string[] };

function httpRequest(opts: http.RequestOptions, body?: string): Promise<Resp> {
  return new Promise(resolve => {
    const fail = () => resolve({ status: 0, body: '', cookies: [] });
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', (d: Buffer) => data += d);
      res.on('end', () => {
        const cookies = (res.headers['set-cookie'] ?? []) as string[];
        resolve({ status: res.statusCode ?? 0, body: data, cookies });
      });
    });
    req.on('error', fail);
    req.setTimeout(10000, () => { req.destroy(); fail(); });
    if (body) req.write(body);
    req.end();
  });
}

function arrGet(port: number, path: string, apiKey: string): Promise<Resp> {
  return httpRequest({ hostname: 'localhost', port, path, headers: { 'X-Api-Key': apiKey } });
}

function arrPost(port: number, path: string, apiKey: string, body: object): Promise<Resp> {
  const data = JSON.stringify(body);
  return httpRequest({
    hostname: 'localhost', port, path, method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(data)),
    },
  }, data);
}

function jsonPost(port: number, path: string, body: object, extraHeaders: Record<string, string> = {}): Promise<Resp> {
  const data = JSON.stringify(body);
  return httpRequest({
    hostname: 'localhost', port, path, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(data)),
      ...extraHeaders,
    },
  }, data);
}

function jsonPut(port: number, path: string, body: object, extraHeaders: Record<string, string> = {}): Promise<Resp> {
  const data = JSON.stringify(body);
  return httpRequest({
    hostname: 'localhost', port, path, method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(data)),
      ...extraHeaders,
    },
  }, data);
}

function formPost(port: number, path: string, formBody: string, extraHeaders: Record<string, string> = {}): Promise<Resp> {
  return httpRequest({
    hostname: 'localhost', port, path, method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(formBody)),
      'Referer': `http://localhost:${port}`,
      ...extraHeaders,
    },
  }, formBody);
}

// ── Wait for service ─────────────────────────────────────────────

async function waitReady(port: number, path: string, apiKey = '', maxWaitSecs = 180): Promise<boolean> {
  const attempts = Math.ceil(maxWaitSecs / 5);
  for (let i = 0; i < attempts; i++) {
    const { status } = await (apiKey
      ? arrGet(port, path, apiKey)
      : httpRequest({ hostname: 'localhost', port, path }));
    if (status > 0 && status < 500) return true;
    await sleep(5000);
  }
  return false;
}

// ── Jellyfin ─────────────────────────────────────────────────────

async function configureJellyfin(port: number, adminPassword: string): Promise<void> {
  // Wait until the startup wizard endpoint responds (up to 3 minutes)
  const ready = await waitReady(port, '/Startup/Configuration', '', 180);
  if (!ready) throw new Error('Jellyfin not ready');

  // If wizard already completed, /Startup/Configuration returns 4xx — skip
  const check = await httpRequest({ hostname: 'localhost', port, path: '/Startup/Configuration' });
  if (check.status !== 200) return;

  // Complete all wizard steps — throw on failure so withRetry can retry
  const cfg1 = await jsonPost(port, '/Startup/Configuration', {
    UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en',
  });
  if (cfg1.status < 200 || cfg1.status >= 300) throw new Error(`Startup/Configuration failed: ${cfg1.status}`);

  const cfg2 = await jsonPost(port, '/Startup/RemoteAccess', {
    EnableRemoteAccess: true, EnableAutomaticPortMapping: false,
  });
  if (cfg2.status < 200 || cfg2.status >= 300) throw new Error(`Startup/RemoteAccess failed: ${cfg2.status}`);

  const cfg3 = await jsonPost(port, '/Startup/User', {
    Name: 'admin', Password: adminPassword,
  });
  if (cfg3.status < 200 || cfg3.status >= 300) throw new Error(`Startup/User failed: ${cfg3.status} — ${cfg3.body.slice(0, 200)}`);

  const cfg4 = await jsonPost(port, '/Startup/Complete', {});
  if (cfg4.status < 200 || cfg4.status >= 300) throw new Error(`Startup/Complete failed: ${cfg4.status}`);

  // Short pause while Jellyfin initialises post-wizard
  await sleep(4000);

  // Authenticate using the new Authorization header (required on Jellyfin 10.11+;
  // X-Emby-Authorization is legacy and disabled by default on 10.12+)
  try {
    const mediaAuth = 'MediaBrowser Client="Gecko", Device="Setup", DeviceId="gecko-setup-v1", Version="1.0"';
    const authResp = await jsonPost(port, '/Users/AuthenticateByName',
      { Username: 'admin', Pw: adminPassword },
      { 'Authorization': mediaAuth },
    );
    if (authResp.status !== 200) return;
    const { AccessToken } = JSON.parse(authResp.body) as { AccessToken: string };
    const authHeaders = { 'Authorization': `MediaBrowser Token="${AccessToken}"` };

    // Set server name to 'Gecko'
    const cfgResp = await httpRequest({
      hostname: 'localhost', port, path: '/System/Configuration', headers: authHeaders,
    });
    if (cfgResp.status === 200) {
      const sysCfg = JSON.parse(cfgResp.body) as Record<string, unknown>;
      sysCfg.ServerName = 'Gecko';
      const body = JSON.stringify(sysCfg);
      await httpRequest({
        hostname: 'localhost', port, path: '/System/Configuration', method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      }, body);
    }

    // Enable legacy authorization so Jellyseerr (which still uses X-Emby-Authorization)
    // can authenticate. Jellyfin 10.12+ disables this by default.
    const netResp = await httpRequest({
      hostname: 'localhost', port, path: '/System/Configuration/Network', headers: authHeaders,
    });
    if (netResp.status === 200) {
      const netCfg = JSON.parse(netResp.body) as Record<string, unknown>;
      netCfg.EnableLegacyAuthorization = true;
      const body = JSON.stringify(netCfg);
      await httpRequest({
        hostname: 'localhost', port, path: '/System/Configuration/Network', method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      }, body);
    }
  } catch { /* post-wizard extras are best-effort — wizard completion is what matters */ }
}

// ── API key reader ───────────────────────────────────────────────

// LinuxServer.io *arr images generate their own API key on first boot.
// X_API_KEY env var is NOT honoured — we must read the key from config.xml.
async function readArrApiKey(containerName: string, dockerEnvObj: NodeJS.ProcessEnv): Promise<string> {
  for (let i = 0; i < 12; i++) {
    try {
      const { stdout } = await execAsync(`docker exec ${containerName} cat /config/config.xml`, { env: dockerEnvObj });
      const m = stdout.match(/<ApiKey>([a-zA-Z0-9]+)<\/ApiKey>/);
      if (m?.[1]) return m[1];
    } catch { /* container not ready yet */ }
    await sleep(5000);
  }
  throw new Error(`Could not read API key from ${containerName}`);
}

// ── qBittorrent ──────────────────────────────────────────────────

// Reads the temporary WebUI password printed by linuxserver/qbittorrent on first boot.
async function qbitTempPassword(dockerEnvObj: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execAsync('docker logs media_qbittorrent 2>&1', { env: dockerEnvObj });
    const m = stdout.match(/temporary password[^:]*:\s*([A-Za-z0-9]+)/i);
    return m?.[1] ?? null;
  } catch { return null; }
}

async function qbitLogin(port: number, password: string): Promise<string | null> {
  const body = `username=admin&password=${encodeURIComponent(password)}`;
  const resp = await formPost(port, '/api/v2/auth/login', body);
  if (resp.body.trim() !== 'Ok.') return null;
  const cookie = resp.cookies.find(c => c.startsWith('SID='));
  return cookie?.match(/SID=([^;]+)/)?.[1] ?? null;
}

async function configureQbit(port: number, adminPassword: string, dockerEnvObj: NodeJS.ProcessEnv): Promise<void> {
  const ready = await waitReady(port, '/api/v2/app/version', '', 120);
  if (!ready) throw new Error('qBittorrent not ready');

  let sid = await qbitLogin(port, adminPassword);

  if (!sid) {
    // Pre-configured PBKDF2 login failed — fall back to the temporary password
    // that linuxserver/qbittorrent prints on first boot, then change to adminPassword.
    const tempPass = await qbitTempPassword(dockerEnvObj);
    if (tempPass) {
      sid = await qbitLogin(port, tempPass);
      if (sid) {
        const chg = JSON.stringify({ web_ui_password: adminPassword });
        await formPost(port, '/api/v2/app/setPreferences', `json=${encodeURIComponent(chg)}`, { Cookie: `SID=${sid}` });
        await sleep(2000);
        sid = await qbitLogin(port, adminPassword);
      }
    }
  }

  if (!sid) throw new Error('qBittorrent login failed');

  const json = JSON.stringify({ save_path: '/downloads' });
  await formPost(port, '/api/v2/app/setPreferences', `json=${encodeURIComponent(json)}`, { Cookie: `SID=${sid}` });
}

// ── *arr helpers ─────────────────────────────────────────────────

function makeQbitDownloadClient(qbitHost: string, adminPassword: string, categoryField: string, categoryValue: string): object {
  return {
    enable: true,
    protocol: 'torrent',
    priority: 1,
    removeCompletedDownloads: true,
    removeFailedDownloads: true,
    name: 'qBittorrent',
    fields: [
      { name: 'host', value: qbitHost },
      { name: 'port', value: 8080 },
      { name: 'useSsl', value: false },
      { name: 'urlBase', value: '' },
      { name: 'username', value: 'admin' },
      { name: 'password', value: adminPassword },
      { name: categoryField, value: categoryValue },
      { name: 'recentMoviePriority', value: 0 },
      { name: 'olderMoviePriority', value: 0 },
      { name: 'initialState', value: 0 },
      { name: 'sequentialOrder', value: false },
      { name: 'firstAndLast', value: false },
    ],
    implementationName: 'qBittorrent',
    implementation: 'QBittorrent',
    configContract: 'QBittorrentSettings',
    tags: [],
  };
}

async function arrAddDownloadClient(port: number, apiKey: string, body: object, apiVersion = 'v3'): Promise<void> {
  const existing = await arrGet(port, `/api/${apiVersion}/downloadclient`, apiKey);
  if (existing.status === 200) {
    const clients = JSON.parse(existing.body) as { implementation: string }[];
    if (clients.some(c => c.implementation === 'QBittorrent')) return;
  }
  await arrPost(port, `/api/${apiVersion}/downloadclient`, apiKey, body);
}

async function arrAddRootFolder(port: number, apiKey: string, folderPath: string, apiVersion = 'v3'): Promise<void> {
  const existing = await arrGet(port, `/api/${apiVersion}/rootfolder`, apiKey);
  if (existing.status === 200) {
    const folders = JSON.parse(existing.body) as { path: string }[];
    if (folders.some(f => f.path === folderPath)) return;
  }
  await arrPost(port, `/api/${apiVersion}/rootfolder`, apiKey, { path: folderPath });
}

// Sets Forms-based web UI authentication on a *arr service, then restarts the
// container so the updated config.xml is read on the next boot.
// versionPath is '/api/v3' for Radarr/Sonarr/Lidarr, '/api/v1' for Prowlarr.
async function arrSetFormAuth(
  port: number, apiKey: string, versionPath: string,
  username: string, password: string,
  containerName: string, dockerEnvObj: NodeJS.ProcessEnv,
): Promise<void> {
  const current = await arrGet(port, `${versionPath}/config/host`, apiKey);
  if (current.status !== 200) throw new Error(`GET config/host failed: ${current.status}`);
  const cfg = JSON.parse(current.body) as Record<string, unknown>;
  cfg.authenticationMethod = 'Forms';
  cfg.authenticationRequired = 'Enabled';
  cfg.username = username;
  cfg.password = password;
  const data = JSON.stringify(cfg);
  const putResp = await httpRequest({
    hostname: 'localhost', port, path: `${versionPath}/config/host`, method: 'PUT',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(data)),
    },
  }, data);
  if (putResp.status < 200 || putResp.status >= 300) {
    throw new Error(`PUT config/host returned ${putResp.status}: ${putResp.body.slice(0, 300)}`);
  }
  // Restart the container so the updated config.xml is read on next boot.
  // Without restart, v4+ *arr apps can revert AuthenticationMethod to None.
  await execAsync(`docker restart ${containerName}`, { env: dockerEnvObj });
  await waitReady(port, `${versionPath}/system/status`, apiKey, 120);
}

// ── Radarr ───────────────────────────────────────────────────────

async function configureRadarr(
  port: number, adminPassword: string, qbitHost: string,
  dockerEnvObj: NodeJS.ProcessEnv,
): Promise<string> {
  const ready = await waitReady(port, '/api/v3/system/status', '', 180);
  if (!ready) throw new Error('Radarr not ready');

  const apiKey = await readArrApiKey('media_radarr', dockerEnvObj);
  const client = makeQbitDownloadClient(qbitHost, adminPassword, 'movieCategory', 'radarr');
  await arrAddDownloadClient(port, apiKey, client);
  await arrAddRootFolder(port, apiKey, '/movies');
  await arrSetFormAuth(port, apiKey, '/api/v3', 'admin', adminPassword, 'media_radarr', dockerEnvObj);
  return apiKey;
}

// ── Sonarr ───────────────────────────────────────────────────────

async function configureSonarr(
  port: number, adminPassword: string, qbitHost: string,
  dockerEnvObj: NodeJS.ProcessEnv,
): Promise<string> {
  const ready = await waitReady(port, '/api/v3/system/status', '', 180);
  if (!ready) throw new Error('Sonarr not ready');

  const apiKey = await readArrApiKey('media_sonarr', dockerEnvObj);
  const client = makeQbitDownloadClient(qbitHost, adminPassword, 'tvCategory', 'sonarr');
  await arrAddDownloadClient(port, apiKey, client);
  await arrAddRootFolder(port, apiKey, '/tv');
  await arrSetFormAuth(port, apiKey, '/api/v3', 'admin', adminPassword, 'media_sonarr', dockerEnvObj);
  return apiKey;
}

// ── Lidarr ───────────────────────────────────────────────────────

async function configureLidarr(
  port: number, adminPassword: string, qbitHost: string,
  dockerEnvObj: NodeJS.ProcessEnv,
): Promise<string> {
  // Lidarr v2.x uses API v1 (not v3 like Radarr/Sonarr)
  const ready = await waitReady(port, '/api/v1/system/status', '', 180);
  if (!ready) throw new Error('Lidarr not ready');

  const apiKey = await readArrApiKey('media_lidarr', dockerEnvObj);
  const client = makeQbitDownloadClient(qbitHost, adminPassword, 'musicCategory', 'lidarr');
  await arrAddDownloadClient(port, apiKey, client, 'v1');
  await arrAddRootFolder(port, apiKey, '/music', 'v1');
  await arrSetFormAuth(port, apiKey, '/api/v1', 'admin', adminPassword, 'media_lidarr', dockerEnvObj);
  return apiKey;
}

// ── Prowlarr ─────────────────────────────────────────────────────

async function prowlarrAddApp(port: number, prowlarrKey: string, body: object): Promise<void> {
  const existing = await arrGet(port, '/api/v1/applications', prowlarrKey);
  if (existing.status === 200) {
    const apps = JSON.parse(existing.body) as { implementation: string }[];
    const target = body as { implementation: string };
    if (apps.some(a => a.implementation === target.implementation)) return;
  }
  await arrPost(port, '/api/v1/applications', prowlarrKey, body);
}

async function configureProwlarr(
  port: number, adminPassword: string,
  radarrPort: number, sonarrPort: number, lidarrPort: number,
  dockerEnvObj: NodeJS.ProcessEnv,
): Promise<string> {
  const ready = await waitReady(port, '/api/v1/system/status', '', 180);
  if (!ready) throw new Error('Prowlarr not ready');

  const prowlarrKey = await readArrApiKey('media_prowlarr', dockerEnvObj);
  const radarrKey   = await readArrApiKey('media_radarr',   dockerEnvObj);
  const sonarrKey   = await readArrApiKey('media_sonarr',   dockerEnvObj);
  const lidarrKey   = await readArrApiKey('media_lidarr',   dockerEnvObj);

  await prowlarrAddApp(port, prowlarrKey, {
    syncLevel: 'fullSync',
    name: 'Radarr',
    fields: [
      { name: 'prowlarrUrl', value: `http://media_prowlarr:${port}` },
      { name: 'baseUrl', value: `http://media_radarr:${radarrPort}` },
      { name: 'apiKey', value: radarrKey },
      { name: 'syncCategories', value: [2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080] },
      { name: 'animeSyncCategories', value: [] },
      { name: 'syncAnimeStandardFormat', value: false },
    ],
    implementationName: 'Radarr',
    implementation: 'Radarr',
    configContract: 'RadarrSettings',
    tags: [],
  });

  await prowlarrAddApp(port, prowlarrKey, {
    syncLevel: 'fullSync',
    name: 'Sonarr',
    fields: [
      { name: 'prowlarrUrl', value: `http://media_prowlarr:${port}` },
      { name: 'baseUrl', value: `http://media_sonarr:${sonarrPort}` },
      { name: 'apiKey', value: sonarrKey },
      { name: 'syncCategories', value: [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5060, 5070, 5080] },
      { name: 'animeSyncCategories', value: [5070] },
      { name: 'syncAnimeStandardFormat', value: false },
    ],
    implementationName: 'Sonarr',
    implementation: 'Sonarr',
    configContract: 'SonarrSettings',
    tags: [],
  });

  await prowlarrAddApp(port, prowlarrKey, {
    syncLevel: 'fullSync',
    name: 'Lidarr',
    fields: [
      { name: 'prowlarrUrl', value: `http://media_prowlarr:${port}` },
      { name: 'baseUrl', value: `http://media_lidarr:${lidarrPort}` },
      { name: 'apiKey', value: lidarrKey },
      { name: 'syncCategories', value: [3000, 3010, 3020, 3030, 3040] },
      { name: 'animeSyncCategories', value: [] },
      { name: 'syncAnimeStandardFormat', value: false },
    ],
    implementationName: 'Lidarr',
    implementation: 'Lidarr',
    configContract: 'LidarrSettings',
    tags: [],
  });

  await arrSetFormAuth(port, prowlarrKey, '/api/v1', 'admin', adminPassword, 'media_prowlarr', dockerEnvObj);
  return prowlarrKey;
}

// ── Bazarr ───────────────────────────────────────────────────────

async function configureBazarr(
  port: number, subtitleLangs: string[], dockerEnvObj: NodeJS.ProcessEnv, adminPassword: string,
): Promise<void> {
  const radarrApiKey = await readArrApiKey('media_radarr', dockerEnvObj);
  const sonarrApiKey = await readArrApiKey('media_sonarr', dockerEnvObj);
  const ready = await waitReady(port, '/api/system/status', '', 120);
  if (!ready) throw new Error('Bazarr not ready');

  // Bazarr generates its own API key — read from config file (newer versions use .yaml)
  let bazarrKey = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      let raw = '';
      try {
        const { stdout } = await execAsync('docker exec media_bazarr cat /config/config/config.yaml', { env: dockerEnvObj });
        raw = stdout;
      } catch { /* fall through to .ini */ }
      if (!raw.match(/apikey/i)) {
        const { stdout } = await execAsync('docker exec media_bazarr cat /config/config/config.ini', { env: dockerEnvObj });
        raw = stdout;
      }
      const m = raw.match(/apikey[:\s=]+([a-f0-9]{32,})/i);
      bazarrKey = m?.[1] ?? '';
      if (bazarrKey) break;
    } catch { /* retry */ }
    await sleep(5000);
  }
  if (!bazarrKey) throw new Error('Could not read Bazarr API key');

  const headers = { 'X-API-KEY': bazarrKey };

  // Connect Radarr
  await jsonPost(port, '/api/radarr', {
    enabled: true, ip: 'media_radarr', port: 7878,
    apikey: radarrApiKey, ssl: false, base_url: '', movies_sync: 60,
  }, headers);

  // Connect Sonarr
  await jsonPost(port, '/api/sonarr', {
    enabled: true, ip: 'media_sonarr', port: 8989,
    apikey: sonarrApiKey, ssl: false, base_url: '', series_sync: 60,
  }, headers);

  // Create subtitle language profile
  if (subtitleLangs.length > 0) {
    const profileItems = subtitleLangs.map(code => ({
      language: code, hi: false, forced: false, audio_exclude: false,
    }));
    const profileResp = await jsonPost(port, '/api/profile', {
      name: 'Gecko', items: profileItems, cutoff: null, mustContain: [], mustNotContain: [],
    }, headers);
    if (profileResp.status === 200 || profileResp.status === 201) {
      try {
        const profile = JSON.parse(profileResp.body) as { id: number };
        if (profile.id) {
          // Set as default for movies and series
          const data = JSON.stringify({ general: { serie_default_profile: profile.id, movie_default_profile: profile.id } });
          await httpRequest({
            hostname: 'localhost', port, path: '/api/system/settings', method: 'POST',
            headers: { 'X-API-KEY': bazarrKey, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) },
          }, data);
        }
      } catch { /* best-effort */ }
    }
  }

  // Set form authentication for Bazarr web UI
  await jsonPost(port, '/api/system/settings', {
    auth: { type: 'form', username: 'admin', password: adminPassword },
  }, headers);
}

// ── Jellyseerr ───────────────────────────────────────────────────

function extractCookie(cookies: string[], name: string): string {
  const found = cookies.find(c => c.startsWith(`${name}=`));
  return found?.split(';')[0] ?? '';
}

async function configureJellyseerr(
  port: number, jellyfinPort: number, adminPassword: string,
  radarrPort: number, sonarrPort: number,
  dockerEnvObj: NodeJS.ProcessEnv,
): Promise<void> {
  const radarrKey = await readArrApiKey('media_radarr', dockerEnvObj);
  const sonarrKey = await readArrApiKey('media_sonarr', dockerEnvObj);
  const ready = await waitReady(port, '/api/v1/status', '', 120);
  if (!ready) throw new Error('Jellyseerr not ready');

  // Check if Jellyseerr is already initialized
  const statusResp = await httpRequest({ hostname: 'localhost', port, path: '/api/v1/status' });
  if (statusResp.status !== 200) throw new Error('Jellyseerr status check failed');
  try {
    const status = JSON.parse(statusResp.body) as { initialized?: boolean };
    if (status.initialized) return; // Already configured — success, no retry needed
  } catch { throw new Error('Failed to parse Jellyseerr status'); }

  // Authenticate via Jellyfin credentials — this creates the Jellyseerr admin account
  const authResp = await jsonPost(port, '/api/v1/auth/jellyfin', {
    username: 'admin',
    password: adminPassword,
    hostname: `http://media_jellyfin:${jellyfinPort}`,
  });
  if (authResp.status !== 200) throw new Error('Jellyseerr auth failed');

  const sessionCookie = extractCookie(authResp.cookies, 'connect.sid');
  if (!sessionCookie) throw new Error('Jellyseerr session cookie missing');

  // Configure Jellyfin connection
  await jsonPut(port, '/api/v1/settings/jellyfin', {
    hostname: `http://media_jellyfin:${jellyfinPort}`,
    externalHostname: '',
    activeDirectory: false,
    enablePathMappings: false,
    pathMappings: [],
  }, { Cookie: sessionCookie });

  // Test Radarr to get quality profiles, then add it
  const radarrTestResp = await jsonPost(port, '/api/v1/settings/radarr/test', {
    name: 'Radarr', hostname: 'media_radarr', port: radarrPort,
    apiKey: radarrKey, useSsl: false, baseUrl: '', is4k: false,
  }, { Cookie: sessionCookie });

  let radarrProfileId = 1;
  if (radarrTestResp.status === 200) {
    const profiles = JSON.parse(radarrTestResp.body) as { id: number }[];
    if (profiles.length > 0) radarrProfileId = profiles[0].id;
  }

  await jsonPost(port, '/api/v1/settings/radarr', {
    name: 'Radarr', hostname: 'media_radarr', port: radarrPort,
    apiKey: radarrKey, useSsl: false, baseUrl: '',
    activeProfileId: radarrProfileId, rootFolder: '/movies',
    minimumAvailability: 'released', tags: [],
    is4k: false, isDefault: true, externalUrl: '',
  }, { Cookie: sessionCookie });

  // Test Sonarr to get quality profiles, then add it
  const sonarrTestResp = await jsonPost(port, '/api/v1/settings/sonarr/test', {
    name: 'Sonarr', hostname: 'media_sonarr', port: sonarrPort,
    apiKey: sonarrKey, useSsl: false, baseUrl: '', enableSeasonFolders: true,
  }, { Cookie: sessionCookie });

  let sonarrProfileId = 1;
  if (sonarrTestResp.status === 200) {
    const profiles = JSON.parse(sonarrTestResp.body) as { id: number }[];
    if (profiles.length > 0) sonarrProfileId = profiles[0].id;
  }

  await jsonPost(port, '/api/v1/settings/sonarr', {
    name: 'Sonarr', hostname: 'media_sonarr', port: sonarrPort,
    apiKey: sonarrKey, useSsl: false, baseUrl: '',
    activeProfileId: sonarrProfileId, rootFolder: '/tv',
    tags: [], animeProfileId: sonarrProfileId, animeRootFolder: '/tv',
    animeTags: [], enableSeasonFolders: true,
    isDefault: true, externalUrl: '',
  }, { Cookie: sessionCookie });
}

// ── Main export ──────────────────────────────────────────────────

export interface AutoSetupConfig {
  adminPassword: string;
  subtitleLangs: string[];
  ports: {
    jellyfin: number; radarr: number; sonarr: number; lidarr: number;
    prowlarr: number; bazarr: number; qbit: number; jellyseerr: number;
  };
  vpnEnabled: boolean;
  dockerEnvObj: NodeJS.ProcessEnv;
  onProgress: (step: number) => void;
  onStepFailed?: (step: number) => void;
}

export async function runAutoSetup(cfg: AutoSetupConfig): Promise<{
  failedSteps: Array<{ step: number; error: string }>;
  apiKeys: { radarr: string; sonarr: string; lidarr: string; prowlarr: string };
}> {
  const { adminPassword, subtitleLangs, ports, vpnEnabled, dockerEnvObj, onProgress, onStepFailed } = cfg;
  const qbitHost = vpnEnabled ? 'media_gluetun' : 'media_qbittorrent';
  const failedSteps: Array<{ step: number; error: string }> = [];
  const actualKeys = { radarr: '', sonarr: '', lidarr: '', prowlarr: '' };

  const tryStep = async (step: number, fn: () => Promise<void>) => {
    onProgress(step);
    try {
      await withRetry(fn);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failedSteps.push({ step, error });
      onStepFailed?.(step);
    }
  };

  await tryStep(3, () => configureJellyfin(ports.jellyfin, adminPassword));
  await tryStep(4, () => configureQbit(ports.qbit, adminPassword, dockerEnvObj));
  await tryStep(5, async () => { actualKeys.radarr  = await configureRadarr(ports.radarr,  adminPassword, qbitHost, dockerEnvObj); });
  await tryStep(6, async () => { actualKeys.sonarr  = await configureSonarr(ports.sonarr,  adminPassword, qbitHost, dockerEnvObj); });
  await tryStep(7, async () => { actualKeys.lidarr  = await configureLidarr(ports.lidarr,  adminPassword, qbitHost, dockerEnvObj); });
  await tryStep(8, async () => { actualKeys.prowlarr = await configureProwlarr(
    ports.prowlarr, adminPassword, ports.radarr, ports.sonarr, ports.lidarr, dockerEnvObj,
  ); });
  await tryStep(9,  () => configureBazarr(ports.bazarr, subtitleLangs, dockerEnvObj, adminPassword));
  await tryStep(10, () => configureJellyseerr(
    ports.jellyseerr, ports.jellyfin, adminPassword,
    ports.radarr, ports.sonarr, dockerEnvObj,
  ));

  return { failedSteps, apiKeys: actualKeys };
}