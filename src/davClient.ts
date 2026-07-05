import { DavConfig } from './config'

function getBasicAuth(str: string): string {
  try {
    return globalThis.btoa(str)
  } catch {
    return ''
  }
}

export function getDavAuthHeader(config: DavConfig): HeadersInit {
  if (config.username && config.password) {
    const basic = getBasicAuth(`${config.username}:${config.password}`)
    return basic ? { Authorization: `Basic ${basic}` } : {}
  }
  return {}
}

export interface DavItem {
  filename: string
  basename: string
  lastmod: string
  size: number
  type: 'directory' | 'file'
}

function extractTag(xml: string, tag: string): string {
  const searchStr = xml.toLowerCase()
  const lowerTag = tag.toLowerCase()
  let openIdx = searchStr.indexOf(`<${lowerTag}`)
  if (openIdx === -1) {
    const prefixedIdx = searchStr.indexOf(`:${lowerTag}`)
    if (prefixedIdx !== -1) {
      const pre = searchStr.lastIndexOf('<', prefixedIdx)
      openIdx = pre !== -1 ? pre : -1
    }
  }
  if (openIdx === -1) return ''

  const closeBracketIdx = searchStr.indexOf('>', openIdx)
  if (closeBracketIdx === -1) return ''

  const tagContent = searchStr.substring(openIdx + 1, closeBracketIdx)
  const prefix = tagContent.split(' ')[0]
  const closingTag = `</${prefix}>`
  const closeIdx = searchStr.indexOf(closingTag, closeBracketIdx + 1)
  if (closeIdx !== -1) return xml.substring(closeBracketIdx + 1, closeIdx)
  return ''
}

function extractAllTags(xml: string, tag: string): string[] {
  const results: string[] = []
  const searchStr = xml.toLowerCase()
  const lowerTag = tag.toLowerCase()
  let currentIndex = 0

  while (true) {
    const openIdx = searchStr.indexOf('<', currentIndex)
    if (openIdx === -1) break

    const closeBracketIdx = searchStr.indexOf('>', openIdx)
    if (closeBracketIdx === -1) break

    const tagContent = searchStr.substring(openIdx + 1, closeBracketIdx)
    const isTarget = tagContent === lowerTag
      || tagContent.endsWith(`:${lowerTag}`)
      || tagContent.startsWith(`${lowerTag} `)
      || tagContent.includes(`:${lowerTag} `)

    if (isTarget) {
      const prefix = tagContent.split(' ')[0]
      const closingTag = `</${prefix}>`
      const closeIdx = searchStr.indexOf(closingTag, closeBracketIdx + 1)
      if (closeIdx !== -1) {
        results.push(xml.substring(closeBracketIdx + 1, closeIdx))
        currentIndex = closeIdx + closingTag.length
      } else {
        currentIndex = closeBracketIdx + 1
      }
    } else {
      currentIndex = closeBracketIdx + 1
    }
  }

  return results
}

export async function propfind(config: DavConfig, path: string): Promise<DavItem[]> {
  const url = config.url.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path)
  const reqUrl = url.replace(/([^:])\/\//g, '$1/')
  const response = await fetch(reqUrl, {
    method: 'PROPFIND',
    headers: {
      ...getDavAuthHeader(config),
      Depth: '1',
    },
  })

  if (!response.ok) {
    throw new Error(`WebDAV PROPFIND failed: ${response.status} ${response.statusText}`)
  }

  const xmlText = await response.text()
  const responses = extractAllTags(xmlText, 'response')

  return responses.map((r: string) => {
    const href = extractTag(r, 'href')
    const decodedHref = decodeURIComponent(href)
    const basename = decodedHref.split('/').filter(Boolean).pop() || ''
    const propstat = extractTag(r, 'propstat')
    const prop = extractTag(propstat, 'prop')
    const resourcetype = extractTag(prop, 'resourcetype')
    const isCollection = /<([^:>]+:)?collection/i.test(resourcetype)
    const lastmod = extractTag(prop, 'getlastmodified')
    const contentLength = extractTag(prop, 'getcontentlength')

    return {
      filename: decodedHref,
      basename,
      lastmod: lastmod || '',
      size: parseInt(contentLength || '0', 10),
      type: isCollection ? 'directory' : 'file',
    }
  })
}

export function buildDavStreamUrl(config: DavConfig, path: string): string {
  let rawUrl: string
  if (path.startsWith('http')) {
    rawUrl = path
  } else {
    const base = config.url.replace(/\/$/, '')
    // 去重路径前缀：PROPFIND 返回的 href 包含服务器根路径（如 /dav/music/song.mp3），
    // config.url 也包含该前缀，需要去掉避免 /dav/dav/...
    let relativePath = path
    try {
      const configPathname = new URL(base).pathname.replace(/\/$/, '')
      if (configPathname && configPathname !== '/' && relativePath.startsWith(configPathname + '/')) {
        relativePath = relativePath.substring(configPathname.length)
      }
    } catch {
      // URL 解析失败，使用原始 path
    }
    const encodedPath = relativePath.split('/').map((s: string) => s ? encodeURIComponent(s) : '').join('/')
    const normalizedPath = encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath
    rawUrl = (base + normalizedPath).replace(/([^:])\/\/+/g, '$1/')
  }

  // 注入认证凭据到 URL：http://user:pass@host/path
  // 这样浏览器 <audio> 标签可以直接播放，无需额外认证头
  if (config.username && config.password) {
    const protoMatch = rawUrl.match(/^(https?:\/\/)(.*)$/)
    if (protoMatch) {
      const encodedUser = encodeURIComponent(config.username)
      const encodedPass = encodeURIComponent(config.password)
      const rest = protoMatch[2].replace(/^[^@]*@/, '')
      rawUrl = protoMatch[1] + encodedUser + ':' + encodedPass + '@' + rest
    }
  }

  return rawUrl
}

export function buildDavProxyStreamUrl(configName: string, relativePath: string): string {
  return `/api/plugin/media-server/lists/${encodeURIComponent(configName)}/dav-stream?path=${encodeURIComponent(relativePath)}`
}

export async function fetchDavFile(config: DavConfig, path: string, range = ''): Promise<Response> {
  const rawUrl = buildDavStreamUrl({ ...config, username: '', password: '' }, path)
  const headers: HeadersInit = {
    ...getDavAuthHeader(config),
  }
  if (range) {
    ;(headers as Record<string, string>).Range = range
  }

  const response = await fetch(rawUrl, { headers })
  if (!response.ok && response.status !== 206) {
    throw new Error(`WebDAV stream failed: ${response.status} ${response.statusText}`)
  }
  return response
}
