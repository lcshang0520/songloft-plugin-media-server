import { createRouter, jsonResponse, createSearchHandler, createMusicUrlHandler } from '@songloft/plugin-sdk'
import type { FallbackMatch, HTTPRequest, HTTPResponse, MusicUrlFallbackHint, SearchResultItem } from '@songloft/plugin-sdk'
import { getConfigs, saveConfigs, getConfig, MediaServerConfig, SubsonicConfig, DavConfig } from './config'
import { ping, getIndexes, getMusicDirectory, getStreamUrl, searchSongs, getStarred, getRandomSongs, getLyrics, getPlaylists, getPlaylistSongs } from './client'
import { propfind, fetchDavFile, buildDavStreamUrl, buildDavProxyStreamUrl } from './davClient'

function parseBody(req: HTTPRequest): any {
  if (!req.body) return {}
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))
    return JSON.parse(str)
  } catch {
    return {}
  }
}

const router = createRouter()
const PLUGIN_ENTRY_PATH = 'media-server'

function getQueryParam(req: HTTPRequest, key: string): string {
  if (!req.query) return ''
  const match = req.query.match(new RegExp(`(?:^|&)${key}=([^&]*)`))
  return match ? decodeURIComponent(match[1]) : ''
}

function getRequestHeader(req: HTTPRequest, key: string): string {
  const headers = req.headers || {}
  const lowerKey = key.toLowerCase()
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === lowerKey) return String(value || '')
  }
  return ''
}

const DAV_STREAM_CHUNK_SIZE = 1024 * 1024

function normalizeDavRange(range: string): string {
  const match = String(range || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return `bytes=0-${DAV_STREAM_CHUNK_SIZE - 1}`

  let start = match[1] ? parseInt(match[1], 10) : 0
  let end = match[2] ? parseInt(match[2], 10) : start + DAV_STREAM_CHUNK_SIZE - 1
  if (!Number.isFinite(start) || start < 0) start = 0
  if (!Number.isFinite(end) || end < start) end = start + DAV_STREAM_CHUNK_SIZE - 1
  if (end - start + 1 > DAV_STREAM_CHUNK_SIZE) end = start + DAV_STREAM_CHUNK_SIZE - 1
  return `bytes=${start}-${end}`
}

function isSubsonic(config: MediaServerConfig): config is SubsonicConfig {
  return (config.type || 'subsonic') === 'subsonic'
}

const MUSIC_EXTENSIONS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'ape', 'alac', 'aiff', 'aif', 'dsf', 'dff'])

function isDavMusicFile(name: string): boolean {
  const cleanName = String(name || '').split('?')[0].split('#')[0]
  const ext = cleanName.split('.').pop()?.toLowerCase() || ''
  return MUSIC_EXTENSIONS.has(ext)
}

function mapSubsonicSong(config: SubsonicConfig, item: any) {
  const title = item.title || item.name || ''
  const artist = item.artist || ''
  return {
    id: item.id,
    name: title,
    type: 'file',
    artist,
    album: item.album,
    duration: item.duration,
    size: item.size,
    streamUrl: getStreamUrl(config, item.id),
    coverArt: item.coverArt ? getStreamUrl(config, item.coverArt).replace('stream', 'getCoverArt') : undefined,
    lyric: `/api/plugin/${PLUGIN_ENTRY_PATH}/lists/${encodeURIComponent(config.name)}/lyric?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`,
    lyric_source: 'url',
    lyricUrl: `/api/plugin/${PLUGIN_ENTRY_PATH}/lists/${encodeURIComponent(config.name)}/lyric?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`,
    sourceType: 'subsonic',
    configName: config.name,
    songId: item.id,
  }
}

async function buildPluginUrl(path: string, params: Record<string, string> = {}): Promise<string> {
  const hostUrl = (await songloft.plugin.getHostUrl()).replace(/\/$/, '')
  const token = await songloft.plugin.getToken()
  const qs = new URLSearchParams({ ...params, access_token: token })
  return `${hostUrl}/api/plugin/${PLUGIN_ENTRY_PATH}${path}?${qs.toString()}`
}

async function buildDavProxyUrl(configName: string, path: string): Promise<string> {
  return buildPluginUrl(`/lists/${encodeURIComponent(configName)}/dav-stream`, { path })
}

async function assertPlayableUrl(url: string): Promise<void> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } })
  if (!response.ok && response.status !== 206) {
    throw new Error(`Playback source unavailable: ${response.status} ${response.statusText}`)
  }
}

function scoreCandidate(item: any, hint: { title?: string; artist?: string; duration?: number }): number {
  const title = String(item.title || item.name || '')
  const artist = String(item.artist || '')
  let score = 0
  if (hint.title) {
    if (title === hint.title) score += 0.6
    else if (title.includes(hint.title) || hint.title.includes(title)) score += 0.35
  }
  if (hint.artist) {
    if (artist === hint.artist) score += 0.3
    else if (artist.includes(hint.artist) || hint.artist.includes(artist)) score += 0.15
  }
  if (hint.duration && item.duration) {
    const delta = Math.abs(Number(item.duration) - Number(hint.duration))
    if (delta <= 3) score += 0.1
    else if (delta <= 8) score += 0.05
  }
  return hint.title || hint.artist ? score : 1
}

async function findSubsonicFallback(
  hint: { title?: string; artist?: string; duration?: number },
  excludeConfigName = '',
  excludeSongId = '',
): Promise<{ item: any; config: SubsonicConfig; score: number } | null> {
  const keyword = String([hint.title, hint.artist].filter(Boolean).join(' ') || hint.title || hint.artist || '').trim()
  if (!keyword) return null

  const configs = (await getConfigs()).filter(isSubsonic)
  const candidates: Array<{ item: any; config: SubsonicConfig; score: number }> = []
  await Promise.all(configs.map(async (config) => {
    try {
      const songs = await searchSongs(config, keyword, 1, 10)
      for (const item of songs) {
        if (excludeConfigName && config.name === excludeConfigName && String(item.id) === String(excludeSongId || '')) continue
        const score = scoreCandidate(item, hint)
        if (score >= 0.35) candidates.push({ item, config, score })
      }
    } catch (e) {
      console.error('Fallback search error for ' + config.name + ':', String(e))
    }
  }))

  candidates.sort((a, b) => {
    if (a.config.name !== excludeConfigName && b.config.name === excludeConfigName) return -1
    if (a.config.name === excludeConfigName && b.config.name !== excludeConfigName) return 1
    return b.score - a.score
  })

  for (const candidate of candidates) {
    const url = getStreamUrl(candidate.config, candidate.item.id)
    try {
      await assertPlayableUrl(url)
      return candidate
    } catch {}
  }
  return null
}

function normalizePlaylistId(id: unknown): string {
  const value = String(id || '')
  return value.startsWith('pl-') ? value : `pl-${value}`
}

function unwrapPlaylistId(id: unknown): string {
  return String(id || '').replace(/^pl-/, '')
}

function mapSubsonicPlaylist(playlist: any) {
  return {
    id: normalizePlaylistId(playlist.id),
    name: playlist.name,
    type: 'directory',
    itemType: 'playlist',
    songCount: playlist.songCount,
    duration: playlist.duration,
    owner: playlist.owner,
    sourceType: 'subsonic',
  }
}

function getDavRelativePath(config: DavConfig, itemPath: string): string {
  let itemPathname = itemPath
  if (itemPathname.startsWith('http')) {
    try {
      itemPathname = new URL(itemPathname).pathname
    } catch {}
  }
  const configUrlPath = (() => {
    try {
      return decodeURIComponent(new URL(config.url).pathname).replace(/\/$/, '')
    } catch {
      return ''
    }
  })()
  let relative = decodeURIComponent(itemPathname)
  if (configUrlPath && relative.startsWith(configUrlPath)) {
    relative = relative.slice(configUrlPath.length)
  }
  return relative.startsWith('/') ? relative : '/' + relative
}

// 列出所有配置的媒体服务器
router.get('/lists', async (req: HTTPRequest) => {
  const configs = await getConfigs()
  return jsonResponse(configs.map(c => ({
    id: c.name,
    name: c.name,
    type: c.type || 'subsonic',
    url: c.url,
    username: c.username,
    salt: c.salt
  })))
})

// 添加/更新媒体服务器配置
router.post('/lists', async (req: HTTPRequest) => {
  const data = parseBody(req) as MediaServerConfig
  data.type = data.type || 'subsonic'
  const configs = await getConfigs()
  const existing = configs.findIndex(c => c.name === data.name)
  if (existing >= 0) {
    const oldConfig = configs[existing]
    // 密码留空则保留旧密码配置
    if (!data.password && !data.token) {
      data.password = oldConfig.password
      data.token = oldConfig.token
    }
    configs[existing] = data
  } else {
    configs.push(data)
  }
  await saveConfigs(configs)
  return jsonResponse({ success: true })
})

// 删除配置
router.delete('/lists/:id', async (req: HTTPRequest, params) => {
  const configs = await getConfigs()
  const filtered = configs.filter(c => c.name !== params.id)
  await saveConfigs(filtered)
  return jsonResponse({ success: true })
})

// 测试连接
router.post('/test', async (req: HTTPRequest) => {
  const data = parseBody(req) as MediaServerConfig
  data.type = data.type || 'subsonic'
  try {
    if ((data.type || 'subsonic') === 'dav') {
      const items = await propfind(data as DavConfig, '/')
      return jsonResponse({ success: true, count: items.length })
    }
    const ok = await ping(data as SubsonicConfig)
    return jsonResponse({ success: ok })
  } catch (e) {
    return jsonResponse({ success: false, error: String(e) })
  }
})

// 获取特定配置的目录项
router.get('/lists/:id/items', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) {
    return jsonResponse({ error: 'Config not found' }, 404)
  }

  try {
    if (!isSubsonic(config)) {
      const dirPath = getQueryParam(req, 'path') || '/'
      const items = await propfind(config, dirPath)
      const configUrlPath = (() => {
        try {
          return decodeURIComponent(new URL(config.url).pathname).replace(/\/$/, '')
        } catch {
          return ''
        }
      })()
      const reqPath = dirPath === '/' ? '' : dirPath.replace(/\/$/, '')
      const expectedPathname = configUrlPath + reqPath
      const filteredItems = items.filter(i => {
        let itemPathname = i.filename
        if (itemPathname.startsWith('http')) {
          try {
            itemPathname = new URL(itemPathname).pathname
          } catch {}
        }
        itemPathname = decodeURIComponent(itemPathname).replace(/\/$/, '')
        return itemPathname !== expectedPathname
      })

      const mappedItems = await Promise.all(filteredItems.map(async item => {
        const relativePath = getDavRelativePath(config, item.filename)
        const isMusic = item.type === 'file' && isDavMusicFile(item.basename || relativePath)
        return {
          id: relativePath,
          name: item.basename,
          type: item.type,
          size: item.size,
          streamUrl: isMusic ? buildDavProxyStreamUrl(config.name, relativePath) : '',
          sourceType: 'dav',
          configName: config.name,
          path: relativePath,
          isMusic,
        }
      }))
      return jsonResponse(mappedItems)
    }

    const pathId = getQueryParam(req, 'id')
    if (pathId === 'playlists') {
      const playlists = await getPlaylists(config)
      return jsonResponse(playlists.map((playlist: any) => mapSubsonicPlaylist(playlist)))
    }
    if (pathId && pathId.startsWith('pl-')) {
      const songs = await getPlaylistSongs(config, unwrapPlaylistId(pathId))
      return jsonResponse(songs.map((item: any) => mapSubsonicSong(config, item)))
    }
    if (!pathId || pathId === 'root') {
      // 根目录：获取 Artists
      const artists = await getIndexes(config)
      return jsonResponse(artists.map(a => ({
        id: a.id,
        name: a.name,
        type: 'directory',
        sourceType: 'subsonic'
      })))
    } else {
      // 获取子目录内容
      const items = await getMusicDirectory(config, pathId)
      return jsonResponse(items.map(item => item.isDir ? ({
        id: item.id,
        name: item.title || item.name,
        type: 'directory',
        artist: item.artist,
        album: item.album,
        duration: item.duration,
        size: item.size,
        sourceType: 'subsonic'
      }) : mapSubsonicSong(config, item)))
    }
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

router.get('/lists/:id/dav-stream', async (req: HTTPRequest, params): Promise<HTTPResponse> => {
  const config = await getConfig(params.id)
  if (!config) return jsonResponse({ error: 'Config not found' }, 404)
  if (isSubsonic(config)) return jsonResponse({ error: 'Not a WebDAV config' }, 400)

  const path = getQueryParam(req, 'path')
  if (!path) return jsonResponse({ error: 'Missing path' }, 400)

  try {
    const rangeHeader = getRequestHeader(req, 'Range')
    // 如果有 Range 请求头，按分块模式处理（兼容旧客户端）
    if (rangeHeader) {
      const range = normalizeDavRange(rangeHeader)
      const response = await fetchDavFile(config, path, range)
      if (response.status !== 206) {
        throw new Error('WebDAV server does not support byte-range streaming')
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      const headers: Record<string, string> = {
        'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
        'Accept-Ranges': response.headers.get('Accept-Ranges') || 'bytes',
        'Cache-Control': 'no-store',
      }
      const contentLength = response.headers.get('Content-Length')
      const contentRange = response.headers.get('Content-Range')
      if (contentLength) headers['Content-Length'] = contentLength
      if (contentRange) headers['Content-Range'] = contentRange
      return { statusCode: 206, headers, body: bytes }
    }

    // 无 Range 头时，流式代理整个文件
    // 后端带 Authorization 头请求 WebDAV 服务器，避免浏览器拒绝带凭据的 URL
    const response = await fetchDavFile(config, path)
    if (!response.ok) {
      throw new Error(`WebDAV stream failed: ${response.status} ${response.statusText}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const headers: Record<string, string> = {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Accept-Ranges': response.headers.get('Accept-Ranges') || 'bytes',
      'Cache-Control': 'no-store',
    }
    const contentLength = response.headers.get('Content-Length')
    if (contentLength) headers['Content-Length'] = contentLength
    return { statusCode: 200, headers, body: bytes }
  } catch (e) {
    return jsonResponse({ error: String(e) }, 502)
  }
})

// 全局搜索
router.post('/api/search', createSearchHandler({
  search: async (keyword: string, page = 1, pageSize = 20) => {
    const configs = await getConfigs()
    if (configs.length === 0) return []

    const results: SearchResultItem[] = []

    // 并发搜索所有 Subsonic 服务器
    await Promise.all(configs.filter(isSubsonic).map(async (config) => {
      try {
        const songs = await searchSongs(config, keyword, page, pageSize)
        for (const s of songs) {
          results.push({
            title: s.title,
            artist: s.artist,
            album: s.album,
            duration: s.duration || 0,
            cover_url: s.coverArt ? getStreamUrl(config, s.coverArt).replace('stream', 'getCoverArt') : undefined,
            source_data: { configName: config.name, songId: s.id, type: 'subsonic' },
            lyric: `/api/plugin/${PLUGIN_ENTRY_PATH}/lists/${encodeURIComponent(config.name)}/lyric?artist=${encodeURIComponent(s.artist || '')}&title=${encodeURIComponent(s.title || '')}`,
            lyric_source: 'url',
            lyricUrl: `/api/plugin/${PLUGIN_ENTRY_PATH}/lists/${encodeURIComponent(config.name)}/lyric?artist=${encodeURIComponent(s.artist || '')}&title=${encodeURIComponent(s.title || '')}`
          })
        }
      } catch (e) {
        // 忽略单个服务器错误，但打印日志方便排查
        console.error('Subsonic search error for ' + config.name + ':', String(e))
      }
    }))

    return results
  }
}))

// 播放链接解析
router.post('/api/music/url', createMusicUrlHandler({
  resolveUrl: async (sourceData: Record<string, unknown>) => {
    const data = typeof sourceData === 'string'
      ? JSON.parse(sourceData || '{}')
      : (sourceData || {})
    const configName = data.configName as string
    const songId = data.songId as string
    const path = data.path as string
    const directUrl = (data.url || data.streamUrl) as string
    if (directUrl) return directUrl
    if (!configName || (!songId && !path)) throw new Error('Invalid source_data')

    const config = await getConfig(configName)
    if (!config) throw new Error('Media server config not found: ' + configName)

    if (!isSubsonic(config)) {
      const relativePath = path || directUrl || ''
      return buildDavProxyStreamUrl(config.name, relativePath)
    }
    const url = getStreamUrl(config, songId)
    await assertPlayableUrl(url)
    return url
  },
  fallbackSearch: async (hint: MusicUrlFallbackHint): Promise<FallbackMatch | null> => {
    if (!hint.enabled) return null
    const candidate = await findSubsonicFallback(hint)
    if (!candidate) return null
    return {
      source_data: { configName: candidate.config.name, songId: candidate.item.id, type: 'subsonic' },
      title: candidate.item.title || candidate.item.name || '',
      artist: candidate.item.artist || '',
    }
  },
}))

// POST /api/search/topone — 搜索+匹配+URL解析三合一，返回最佳匹配的可播放 URL
// 供 miot-plus 等插件在本地索引找不到歌曲时调用
router.post('/api/search/topone', async (req: HTTPRequest) => {
  const body = parseBody(req)
  const keyword = String(body.keyword || '').trim()
  const hint: { title?: string; artist?: string; duration?: number } | undefined = body.hint
  const quality = String(body.quality || '320k').trim()
  const excludeConfigName = String(body.excludeConfigName || '').trim()
  const excludeSongId = String(body.excludeSongId || '').trim()

  if (!keyword) return jsonResponse({ code: 400, msg: '缺少 keyword', data: null }, 400)

  const configs = await getConfigs()
  if (configs.length === 0) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 404, msg: 'song not found', data: null }) }
  }

  // 跨所有 Subsonic 服务器并行搜索，每服务器取第1页最多10条
  const allCandidates: Array<{ score: number; item: any; configName: string }> = []
  const searchResults = await Promise.allSettled(
    configs.filter(isSubsonic).map(async (config) => {
      try {
        const songs = await searchSongs(config, keyword, 1, 10)
        return { configName: config.name, items: songs }
      } catch {
        return null
      }
    }),
  )

  for (const result of searchResults) {
    if (result.status !== 'fulfilled' || !result.value) continue
    const { configName, items } = result.value
    for (const item of items) {
      if (excludeConfigName && configName === excludeConfigName && String(item.id) === excludeSongId) continue
      const title = String(item.title || item.name || '')
      const artist = String(item.artist || '')
      if (!title) continue

      let score = 0
      if (hint) {
        // 评分逻辑：title 和 artist 匹配度
        if (hint.title) {
          if (title === hint.title) score += 0.5
          else if (title.includes(hint.title) || hint.title.includes(title)) score += 0.3
        }
        if (hint.artist) {
          if (artist === hint.artist) score += 0.3
          else if (artist.includes(hint.artist) || hint.artist.includes(artist)) score += 0.15
        }
      } else {
        // 无 hint 时，给所有有效结果一个基础分，保证能返回
        score = 1
      }

      if (score < 0.4) continue
      allCandidates.push({ score, item, configName })
    }
  }

  if (allCandidates.length === 0) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 404, msg: 'song not found', data: null }) }
  }

  // 按评分降序排列，依次尝试获取 URL
  allCandidates.sort((a, b) => b.score - a.score)

  let lastError = ''
  for (const candidate of allCandidates) {
    const { item, configName } = candidate
    const config = await getConfig(configName)
    if (!config) continue
    try {
      const url = getStreamUrl(config, item.id)
      if (url) {
        await assertPlayableUrl(url)
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 0,
            msg: 'success',
            data: {
              title: item.title || item.name || '',
              artist: item.artist || '',
              album: item.album || '',
              duration: item.duration || 0,
              cover_url: item.coverArt ? getStreamUrl(config, item.coverArt).replace('stream', 'getCoverArt') : undefined,
              url,
              source_data: { configName, songId: item.id, type: 'subsonic' },
            },
          }),
        }
      }
    } catch (e: any) {
      lastError = e.message || String(e)
      // 单个失败继续尝试下一个候选
    }
  }

  console.warn(`[search/topone] 所有候选 URL 获取均失败，最后错误: ${lastError}`)
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 404, msg: 'song not found', data: null }) }
})

// 新增前端 API - 扁平化搜索
router.get('/lists/:id/search', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) return jsonResponse({ error: 'Config not found' }, 404)
  if (!isSubsonic(config)) return jsonResponse([])

  let keyword = ''
  if (req.query) {
    const match = req.query.match(/(?:^|&)q=([^&]*)/)
    if (match) keyword = decodeURIComponent(match[1])
  }

  try {
    const songs = await searchSongs(config, keyword, 1, 100)
    return jsonResponse(songs.map(item => mapSubsonicSong(config, item)))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

// 新增前端 API - 我的收藏
router.get('/lists/:id/starred', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) return jsonResponse({ error: 'Config not found' }, 404)
  if (!isSubsonic(config)) return jsonResponse([])

  try {
    const songs = await getStarred(config)
    return jsonResponse(songs.map((item: any) => mapSubsonicSong(config, item)))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

// 新增前端 API - 随机/随便听听
router.get('/lists/:id/random', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) return jsonResponse({ error: 'Config not found' }, 404)
  if (!isSubsonic(config)) return jsonResponse([])

  try {
    const songs = await getRandomSongs(config, 50)
    return jsonResponse(songs.map((item: any) => mapSubsonicSong(config, item)))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

router.get('/lists/:id/playlists', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) return jsonResponse({ error: 'Config not found' }, 404)
  if (!isSubsonic(config)) return jsonResponse([])

  try {
    const playlists = await getPlaylists(config)
    return jsonResponse(playlists.map((playlist: any) => mapSubsonicPlaylist(playlist)))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

router.get('/lists/:id/playlists/:playlistId/items', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) return jsonResponse({ error: 'Config not found' }, 404)
  if (!isSubsonic(config)) return jsonResponse([])

  try {
    const songs = await getPlaylistSongs(config, unwrapPlaylistId(params.playlistId))
    return jsonResponse(songs.map((item: any) => mapSubsonicSong(config, item)))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

// 歌词抓取
router.get('/lists/:id/lyric', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) return jsonResponse({ error: 'Config not found' }, 404)

  let artist = ''
  let title = ''
  if (req.query) {
    const artistMatch = req.query.match(/(?:^|&)artist=([^&]*)/)
    if (artistMatch) artist = decodeURIComponent(artistMatch[1])

    const titleMatch = req.query.match(/(?:^|&)title=([^&]*)/)
    if (titleMatch) title = decodeURIComponent(titleMatch[1])
  }

  try {
    const lyric = await getLyrics(config, artist, title)
    return jsonResponse({
      code: 0,
      data: {
        lyric: lyric
      },
      message: 'success'
    })
  } catch (e) {
    // 即使失败也返回标准结构但 code != 0
    return jsonResponse({ code: 1, message: String(e) })
  }
})

export default router
