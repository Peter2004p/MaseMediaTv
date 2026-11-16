import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'tv.masemedia.masenet',
  appName: 'MaseNet',
  webDir: 'dist',
  server: {
    // Keep the Android shell connected to the existing Cloudflare-hosted app and backend.
    url: 'https://masetv-cloudflare-migration.pages.dev',
    cleartext: false,
    allowNavigation: ['masetv-cloudflare-migration.pages.dev'],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
