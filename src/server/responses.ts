const SUBSONIC_VERSION = '1.16.1'
const SERVER_TYPE = 'songloft'

interface SubsonicResponse {
  [key: string]: any
}

export function okResponse(query: URLSearchParams, data?: SubsonicResponse): { body: string; contentType: string } {
  const wrapper: any = {
    'subsonic-response': {
      xmlns: 'http://subsonic.org/restapi',
      status: 'ok',
      version: SUBSONIC_VERSION,
      type: SERVER_TYPE,
      serverVersion: '0.1.0',
      openSubsonic: true,
      ...data
    }
  }
  return formatOutput(query, wrapper)
}

export function errorResponse(query: URLSearchParams, code: number, message: string): { body: string; contentType: string } {
  const wrapper: any = {
    'subsonic-response': {
      xmlns: 'http://subsonic.org/restapi',
      status: 'failed',
      version: SUBSONIC_VERSION,
      type: SERVER_TYPE,
      error: { code, message }
    }
  }
  return formatOutput(query, wrapper)
}

function formatOutput(query: URLSearchParams, data: any): { body: string; contentType: string } {
  const f = query.get('f') || 'xml'
  if (f === 'json') {
    return { body: JSON.stringify(data), contentType: 'application/json; charset=utf-8' }
  }
  return { body: toXml(data), contentType: 'text/xml; charset=utf-8' }
}

function toXml(obj: any, indent: string = ''): string {
  if (typeof obj !== 'object' || obj === null) return escapeXml(String(obj))

  const root = Object.keys(obj)[0]
  const content = obj[root]

  if (typeof content !== 'object' || content === null) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>${escapeXml(String(content))}</${root}>`
  }

  let attrs = ''
  let children = ''

  for (const [key, val] of Object.entries(content)) {
    if (val === null || val === undefined) continue
    if (Array.isArray(val)) {
      for (const item of val) {
        children += renderElement(key, item, indent + '  ')
      }
    } else if (typeof val === 'object') {
      children += renderElement(key, val, indent + '  ')
    } else {
      attrs += ` ${key}="${escapeXml(String(val))}"`
    }
  }

  if (children) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}${attrs}>\n${children}</${root}>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}${attrs}/>`
}

function renderElement(name: string, val: any, indent: string): string {
  if (typeof val !== 'object' || val === null) {
    return `${indent}<${name}>${escapeXml(String(val))}</${name}>\n`
  }

  let attrs = ''
  let children = ''

  for (const [key, v] of Object.entries(val)) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      for (const item of v) {
        children += renderElement(key, item, indent + '  ')
      }
    } else if (typeof v === 'object') {
      children += renderElement(key, v, indent + '  ')
    } else {
      attrs += ` ${key}="${escapeXml(String(v))}"`
    }
  }

  if (children) {
    return `${indent}<${name}${attrs}>\n${children}${indent}</${name}>\n`
  }
  return `${indent}<${name}${attrs}/>\n`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

