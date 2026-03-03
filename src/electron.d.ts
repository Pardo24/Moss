export {};

declare global {
  interface Window {
    electron: {
      checkDocker:    () => Promise<boolean>;
      pickFolder:     () => Promise<string | null>;
      install:        (config: unknown) => Promise<void>;
      openExternal:   (url: string) => void;
      getConfig:      () => Promise<Record<string, string> & { vpnEnabled: boolean } | null>;
      getStatus:      () => Promise<'running' | 'stopped'>;
      startStack:     () => Promise<void>;
      stopStack:      () => Promise<void>;
      getLocalIp:     () => Promise<string>;
      resetInstall:   () => Promise<void>;
      addVpn:         (cfg: { mullvadKey: string; mullvadAddress: string }) => Promise<void>;
      removeVpn:      () => Promise<void>;
    };
  }
}
