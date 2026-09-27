import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.jeff.mobile',
  appName: 'Jeff',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
}

export default config
