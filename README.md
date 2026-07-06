# Songloft 媒体服务器插件

本插件为 Songloft 提供了 Subsonic 和 WebDAV 双协议支持，允许将支持 Subsonic API 的外部音乐服务器（如 Navidrome、Airsonic 等）无缝接入到 Songloft 播放器中，允许将任何标准的 WebDAV 存储（如 AliyunDrive WebDAV、Nextcloud 等）挂载为音乐源。

插件引用自
- 1、Songloft Subsonic插件：https://github.com/songloft-org/songloft-plugin-subsonic
- 2、Songloft WebDAV插件 ：https://github.com/songloft-org/songloft-plugin-dav 

本库就是写着玩、学技术的，希望对大家有用。

## 核心特性

- **多节点管理**：支持同时配置和管理多个 Subsonic/WebDAV 服务器源，支持账号密码认证。
- **WebDAV 支持**：通过 WebDAV PROPFIND 浏览远程音乐文件，支持代理流播放。
- **全站搜索集成**：完全集成了 Songloft 的全局搜索功能，搜索关键词会自动在所有的 Subsonic 节点中并发查找（依赖于 Subsonic 的 `search3` 接口）。
- **音频流解析**：实现直连解析配置，音乐点播直接缓冲流媒体，不占用过多服务器资源，支持对 WebDAV 目录下的歌曲提供直链解析和播放功能。
- **动态歌词获取**：支持抓取 Subsonic 的原生歌词数据（支持本地导入与网络模式）。
- **Subsonic 服务端模式**：可对外提供 Subsonic API，供第三方客户端（Symfonium、DSub 等）访问本机音乐库。

## 开发与构建

基于 `songloft-plugin-sdk` 和 TypeScript 构建，运行在 QuickJS 沙盒中。

```bash
# 安装依赖
pnpm install

# 本地调试与开发
pnpm run dev

# 构建生产环境插件包
pnpm run build
```

## License

Apache-2.0

