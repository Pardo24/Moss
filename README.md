# Gecko 🦎

**Gecko** is a desktop app that lets anyone set up a home media server in minutes — no technical knowledge required.

One installer. Jellyfin, Sonarr, Radarr, Prowlarr, Bazarr, qBittorrent, Jellyseerr and a VPN, all running together with Docker.


---

## Features

- **One-click setup** — choose a folder, set a password, done
- **Full media stack** — movies, series, music, subtitles, requests
- **VPN built-in** — route downloads through any WireGuard provider
- **Step-by-step guide** — in-app walkthrough for first-time configuration
- **Live status** — see which services are running at a glance
- **Network panel** — open any service directly from the app
- **Auto-updates** — always on the latest version
- **Windows & macOS** — native installers for both platforms
- **Trilingual** — Catalan, Spanish and English

---

## Included services

| Service | Purpose |
|---|---|
| [Jellyfin](https://jellyfin.org) | Media server — stream movies, series, music |
| [Radarr](https://radarr.video) | Movie automation |
| [Sonarr](https://sonarr.tv) | Series automation |
| [Lidarr](https://lidarr.audio) | Music automation |
| [Prowlarr](https://prowlarr.com) | Indexer manager |
| [qBittorrent](https://qbittorrent.org) | Download client |
| [Bazarr](https://bazarr.media) | Subtitle manager |
| [Jellyseerr](https://github.com/Fallenbagel/jellyseerr) | Media request portal |
| [Gluetun](https://github.com/qdm12/gluetun) | WireGuard VPN container |

---

## Requirements

- **Docker Desktop** — [download here](https://www.docker.com/products/docker-desktop/)
- Windows 10/11 or macOS 12+
- ~4 GB RAM recommended
- Storage space for your media

---

## Download

Get the latest release for your platform:

👉 **[Download Gecko](https://github.com/Pardo24/Gecko/releases/latest)**

| Platform | File |
|---|---|
| Windows | `Gecko-Setup.exe` |
| macOS | `Gecko.dmg` |

---

## Screenshots

_Coming soon_

---

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run start

# Build for current platform
npm run make
```

**Stack:** Electron · React · TypeScript · Tailwind CSS · Vite

---

## Support

If Gecko saves you time, consider buying me a coffee ☕

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-danipardo24-teal?logo=buy-me-a-coffee)](https://buymeacoffee.com/danipardo24)

---

## License

MIT © [Dani Pardo](https://github.com/Pardo24/Gecko)