import jellyfinSvg    from '../assets/services/jellyfin.svg';
import sonarrSvg      from '../assets/services/sonarr.svg';
import radarrSvg      from '../assets/services/radarr.svg';
import qbittorrentSvg from '../assets/services/qbittorrent.svg';
import prowlarrSvg    from '../assets/services/prowlarr.svg';
import bazarrPng      from '../assets/services/bazarr.png';
import jellyseerrSvg  from '../assets/services/jellyseerr.svg';

export type ServiceName = 'Jellyfin' | 'Jellyseerr' | 'Radarr' | 'Sonarr' | 'Prowlarr' | 'Bazarr' | 'qBittorrent';

const ICONS: Record<ServiceName, string> = {
  Jellyfin:    jellyfinSvg,
  Jellyseerr:  jellyseerrSvg,
  Radarr:      radarrSvg,
  Sonarr:      sonarrSvg,
  Prowlarr:    prowlarrSvg,
  Bazarr:      bazarrPng,
  qBittorrent: qbittorrentSvg,
};

type Props = { name: ServiceName; size?: number; className?: string };

export default function ServiceIcon({ name, size = 28, className }: Props) {
  return (
    <img
      src={ICONS[name]}
      alt={name}
      width={size}
      height={size}
      style={{ objectFit: 'contain' }}
      className={className}
    />
  );
}
