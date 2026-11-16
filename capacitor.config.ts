import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'tv.masemedia.masenet',
  appName: 'MaseNet',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: { CapacitorHttp: { enabled: true } },
};

export default config;
