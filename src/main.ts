import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk'
import router from './router'
import { handleServerRoute } from './server/index'

async function onInit(): Promise<void> {
  console.log('[Media Server Plugin] Mounted')
}

async function onDeinit(): Promise<void> {
  console.log('[Media Server Plugin] Unmounted')
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  // 优先匹配 Subsonic 服务端路由（/rest/* 和 /server/config）
  const serverResp = await handleServerRoute(req)
  if (serverResp) return serverResp

  // 否则走现有客户端路由
  return await router.handle(req)
}

globalThis.onInit = onInit
globalThis.onDeinit = onDeinit
globalThis.onHTTPRequest = onHTTPRequest

