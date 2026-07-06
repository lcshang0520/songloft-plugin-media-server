// global songloft

export type MediaServerType = 'subsonic' | 'dav'

export interface MediaServerConfig {
  type?: MediaServerType
  url: string
  username?: string
  password?: string
  token?: string
  salt?: string
  name: string
  version?: string // e.g. 1.16.1
}

export type SubsonicConfig = MediaServerConfig
export type DavConfig = MediaServerConfig

const CONFIG_KEY = 'media_server_configs'
const LEGACY_SUBSONIC_CONFIG_KEY = 'subsonic_configs'
const LEGACY_DAV_CONFIG_KEY = 'dav_configs'

function normalizeConfig(config: MediaServerConfig, fallbackType: MediaServerType = 'subsonic'): MediaServerConfig {
  return {
    ...config,
    type: config.type || fallbackType,
  }
}

export async function getConfigs(): Promise<MediaServerConfig[]> {
  try {
    const val = await songloft.storage.get(CONFIG_KEY)
    if (val) {
      return (JSON.parse(val) as MediaServerConfig[]).map(c => normalizeConfig(c))
    }

    const legacySubsonic = await songloft.storage.get(LEGACY_SUBSONIC_CONFIG_KEY)
    const legacyDav = await songloft.storage.get(LEGACY_DAV_CONFIG_KEY)
    const migrated: MediaServerConfig[] = []
    if (legacySubsonic) {
      migrated.push(...(JSON.parse(legacySubsonic) as MediaServerConfig[]).map(c => normalizeConfig(c, 'subsonic')))
    }
    if (legacyDav) {
      migrated.push(...(JSON.parse(legacyDav) as MediaServerConfig[]).map(c => normalizeConfig(c, 'dav')))
    }
    if (migrated.length > 0) {
      await saveConfigs(migrated)
      return migrated
    }
  } catch (err) {
    songloft.logger.error('Failed to get media server configs', String(err))
  }
  return []
}

export async function saveConfigs(configs: MediaServerConfig[]): Promise<void> {
  await songloft.storage.set(CONFIG_KEY, JSON.stringify(configs.map(c => normalizeConfig(c))))
}

export async function getConfig(name: string): Promise<MediaServerConfig | undefined> {
  const configs = await getConfigs()
  return configs.find(c => c.name === name)
}

