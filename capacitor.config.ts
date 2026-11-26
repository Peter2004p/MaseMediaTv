import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'tv.masemedia.masenet',
  appName: 'MaseNet',
  webDir: 'dist',
  server: {
    // Keep the native shell on the existing same-origin Cloudflare site; the service worker caches the app shell for offline opening.
    url: 'https://masetv-cloudflare-migration.pages.dev/?masenet_app_shell=20261126-update',
    cleartext: false,
    allowNavigation: ['masetv-cloudflare-migration.pages.dev'],
  },
  android: { allowMixedContent: false },
};

export default config;
