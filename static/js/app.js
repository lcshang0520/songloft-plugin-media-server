let currentServers = []
let currentPathId = 'root'
let pathStack = ['root']
let isSelectMode = false
let selectedItems = new Map() // id -> item
let currentListItems = [] // store current view items
let currentBrowserMode = 'items'
let miniQueue = []
let miniQueueIndex = -1
let miniFallbackTried = new Set()
let miniProgressDragging = false
let miniHandlingError = false

function showSnackbar(message) {
    const snackbar = document.getElementById('snackbar');
    snackbar.textContent = message;
    snackbar.classList.add('show');
    setTimeout(() => {
        snackbar.classList.remove('show');
    }, 3000);
}

function showProgress(show, title = '正在处理', text = '请稍候...') {
    const dlg = document.getElementById('progressDialog')
    if (show) {
        document.getElementById('progressTitle').textContent = title
        document.getElementById('progressText').textContent = text
        dlg.classList.add('show')
    } else {
        dlg.classList.remove('show')
    }
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'))
    document.querySelectorAll('.tab-item').forEach(el => el.classList.remove('active'))
    document.getElementById(`tab-${tabId}`).classList.add('active')
    document.querySelector(`.tab-item[data-tab="${tabId}"]`).classList.add('active')
}

function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = SongloftPlugin.getAuthToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
}

function getSelectedServer() {
    const name = document.getElementById('browserServerSelect').value
    return currentServers.find(s => s.name === name) || null
}

function isCurrentSubsonic() {
    const server = getSelectedServer()
    return !server || (server.type || 'subsonic') === 'subsonic'
}

function getServerTypeLabel(type) {
    return (type || 'subsonic') === 'dav' ? 'WebDAV' : 'Subsonic'
}

const MUSIC_EXTENSIONS = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'ape', 'alac', 'aiff', 'aif', 'dsf', 'dff'])

function isSelectableMusicItem(item) {
    if (!item || item.type !== 'file') return false
    if ((item.sourceType || 'subsonic') !== 'dav') return true
    const name = String(item.name || item.id || item.filename || '')
    const ext = name.split('?')[0].split('#')[0].split('.').pop().toLowerCase()
    return MUSIC_EXTENSIONS.has(ext)
}

function getPluginBaseUrl() {
    const entryPath = '/media-server'
    const { origin, pathname } = window.location
    const entryIndex = pathname.indexOf(entryPath)
    if (entryIndex >= 0) {
        return origin + pathname.slice(0, entryIndex + entryPath.length).replace(/\/+$/, '')
    }
    return origin + pathname.replace(/\/static(?:\/.*)?$/, '').replace(/\/+$/, '')
}

function updateServerTypeFields(prefix = '') {
    const typeEl = document.getElementById(prefix ? 'editType' : 'serverType')
    const type = typeEl ? typeEl.value : 'subsonic'
    const selector = prefix ? '.edit-subsonic-only-field' : '.subsonic-only-field'
    document.querySelectorAll(selector).forEach(el => {
        el.style.display = type === 'subsonic' ? '' : 'none'
    })
}

function updateBrowserActionsVisibility() {
    const subsonic = isCurrentSubsonic()
    document.querySelectorAll('.subsonic-only-action').forEach(el => {
        el.style.display = subsonic ? 'inline-flex' : 'none'
    })
    const pathTitle = document.getElementById('browserPathDisplay')
    if (!subsonic && pathTitle.textContent === 'Artists') {
        pathTitle.textContent = '/'
    }
}

// ... server management functions ...
async function fetchServers() {
    try {
        const res = await fetch('./lists', { headers: getAuthHeaders() })
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        currentServers = data
        renderServerList()
        renderBrowserSelect()
    } catch (e) {
        showSnackbar('获取服务器失败: ' + e)
    }
}

function getFormData() {
    return {
        type: document.getElementById('serverType').value,
        name: document.getElementById('subName').value.trim(),
        url: document.getElementById('subUrl').value.trim(),
        username: document.getElementById('subUsername').value.trim(),
        password: document.getElementById('subPassword').value.trim(),
        salt: document.getElementById('subSalt').value.trim(),
    }
}

async function testServer() {
    const data = getFormData()
    if (!data.url || (data.type === 'subsonic' && !data.username)) { showSnackbar('地址和用户名不能为空'); return }
    const payload = { type: data.type, name: data.name || 'test', url: data.url.replace(/\/$/, ''), username: data.username, version: '1.16.1' }
    if (data.salt) { payload.token = data.password; payload.salt = data.salt } else { payload.password = data.password }
    try {
        const res = await fetch('./test', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(payload) })
        if (!res.ok) throw new Error(await res.text())
        const result = await res.json()
        if (result.success) showSnackbar('测试通过！')
        else showSnackbar('测试失败: ' + (result.error || '未知错误'))
    } catch (e) { showSnackbar('测试请求出错: ' + e) }
}

async function addServer() {
    const data = getFormData()
    if (!data.name || !data.url || (data.type === 'subsonic' && !data.username)) { showSnackbar('名称、地址和用户名不能为空'); return }
    const payload = { type: data.type, name: data.name, url: data.url.replace(/\/$/, ''), username: data.username, version: '1.16.1' }
    if (data.salt) { payload.token = data.password; payload.salt = data.salt } else { payload.password = data.password }
    try {
        const res = await fetch('./lists', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(payload) })
        if (res.ok) {
            showSnackbar('保存成功')
            document.getElementById('subName').value = ''
            document.getElementById('subUrl').value = ''
            document.getElementById('subUsername').value = ''
            document.getElementById('subPassword').value = ''
            document.getElementById('subSalt').value = ''
            fetchServers()
        }
    } catch (e) { showSnackbar('保存失败: ' + e) }
}

async function deleteServer(name) {
    if (!confirm(`确定删除 ${name} 吗？`)) return
    try {
        const res = await fetch(`./lists/${encodeURIComponent(name)}`, { method: 'DELETE', headers: getAuthHeaders() })
        if (res.ok) { showSnackbar('删除成功'); fetchServers() }
    } catch (e) { showSnackbar('删除失败: ' + e) }
}

function openEditDialog(name) {
    const server = currentServers.find(s => s.name === name)
    if (!server) return
    document.getElementById('editType').value = server.type || 'subsonic'
    document.getElementById('editName').value = server.name || ''
    document.getElementById('editUrl').value = server.url || ''
    document.getElementById('editUsername').value = server.username || ''
    document.getElementById('editPassword').value = ''
    document.getElementById('editSalt').value = server.salt || ''
    updateServerTypeFields('edit')
    document.getElementById('editDialog').classList.add('show')
}

function closeEditDialog() { document.getElementById('editDialog').classList.remove('show') }

async function saveEditServer() {
    const data = {
        type: document.getElementById('editType').value,
        name: document.getElementById('editName').value.trim(),
        url: document.getElementById('editUrl').value.trim(),
        username: document.getElementById('editUsername').value.trim(),
        password: document.getElementById('editPassword').value.trim(),
        salt: document.getElementById('editSalt').value.trim(),
    }
    if (!data.url || (data.type === 'subsonic' && !data.username)) { showSnackbar('地址和用户名不能为空'); return }
    const payload = { type: data.type, name: data.name, url: data.url.replace(/\/$/, ''), username: data.username, version: '1.16.1' }
    if (data.salt) { payload.token = data.password; payload.salt = data.salt } else { payload.password = data.password }
    try {
        const res = await fetch('./lists', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(payload) })
        if (res.ok) {
            showSnackbar('修改成功')
            closeEditDialog()
            fetchServers()
        } else showSnackbar('修改失败')
    } catch (e) { showSnackbar('修改异常: ' + e) }
}

function renderServerList() {
    const container = document.getElementById('serverList')
    if (currentServers.length === 0) {
        container.innerHTML = '<div class="empty-state">暂无服务器，请先添加</div>'
        return
    }
    container.innerHTML = ''
    currentServers.forEach(server => {
        const item = document.createElement('div')
        item.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant)'
        item.innerHTML = `
            <div style="flex:1; min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                    <span class="server-type-tag server-type-${server.type || 'subsonic'}">${getServerTypeLabel(server.type)}</span>
                    <div style="font-size:16px;color:var(--md-on-surface);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${server.name}</div>
                </div>
                <div style="font-size:13px;color:var(--md-on-surface-variant);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${server.url}</div>
            </div>
            <div class="list-item-trailing">
                <button class="btn-icon btn-edit" title="编辑" style="color:var(--md-primary)"><span class="material-symbols-outlined">edit</span></button>
                <button class="btn-icon btn-delete" style="color:var(--md-error)" title="删除"><span class="material-symbols-outlined">delete</span></button>
            </div>
        `
        item.querySelector('.btn-edit').onclick = () => openEditDialog(server.name)
        item.querySelector('.btn-delete').onclick = () => deleteServer(server.name)
        container.appendChild(item)
    })
}

// ... browser functions ...
function renderBrowserSelect() {
    const select = document.getElementById('browserServerSelect')
    const currentVal = select.value
    select.innerHTML = '<option value="">请选择服务器...</option>'
    currentServers.forEach(server => {
        const opt = document.createElement('option')
        opt.value = server.name
        opt.textContent = `${server.name} · ${getServerTypeLabel(server.type)}`
        select.appendChild(opt)
    })
    
    if (currentServers.some(s => s.name === currentVal)) {
        select.value = currentVal
        document.getElementById('discoveryArea').style.display = 'flex'
        document.getElementById('toggleSelectModeBtn').style.display = 'block'
        updateBrowserActionsVisibility()
    } else {
        document.getElementById('browserList').innerHTML = '<div class="empty-state">请选择服务器进行浏览</div>'
        document.getElementById('discoveryArea').style.display = 'none'
        document.getElementById('toggleSelectModeBtn').style.display = 'none'
        pathStack = ['root']
        currentPathId = 'root'
    }
}

function renderItems(items, title) {
    currentListItems = items
    const container = document.getElementById('browserList')
    document.getElementById('browserPathDisplay').textContent = title
    
    if (items.length === 0) {
        container.innerHTML = '<div class="empty-state">无音乐文件</div>'
        return
    }
    
    container.innerHTML = ''
    
    const selectableItems = items.filter(isSelectableMusicItem)
    if (isSelectMode && selectableItems.length > 0) {
        const selectAllDiv = document.createElement('div')
        selectAllDiv.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant);cursor:pointer;gap:12px;'
        const allSelected = selectableItems.every(item => selectedItems.has(item.id))
        selectAllDiv.innerHTML = `
            <input type="checkbox" class="checkbox-custom" ${allSelected ? 'checked' : ''} style="pointer-events:none">
            <span style="font-weight:500;font-size:14px;color:var(--md-primary)">全选本页歌曲</span>
        `
        selectAllDiv.onclick = () => {
            const willSelect = !allSelected
            selectableItems.forEach(item => {
                if (willSelect) selectedItems.set(item.id, item)
                else selectedItems.delete(item.id)
            })
            renderItems(items, title) // re-render to update checkboxes
            updateFAB()
        }
        container.appendChild(selectAllDiv)
    } else if (isSelectMode && !items.some(item => item.type === 'directory' || item.type === 'playlist' || item.itemType === 'playlist')) {
        const notice = document.createElement('div')
        notice.className = 'empty-state'
        notice.textContent = '无音乐文件'
        container.appendChild(notice)
    }

    items.forEach(item => {
        const el = document.createElement('div')
        el.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant);cursor:pointer;'
        el.classList.add('browser-item')
        
        const isSelected = selectedItems.has(item.id)
        
        const isPlaylist = item.type === 'playlist' || item.itemType === 'playlist'
        const isMusicFile = isSelectableMusicItem(item)
        const icon = isPlaylist ? 'queue_music' : (item.type === 'directory' ? 'folder_special' : (isMusicFile ? 'music_note' : 'draft'))
        const color = item.type === 'directory' || isPlaylist ? 'var(--md-primary)' : 'var(--md-on-surface)'
        const subtitle = item.type === 'directory'
            ? (isPlaylist ? `${item.songCount || 0} 首歌曲${item.owner ? ' · ' + item.owner : ''}` : (item.sourceType === 'dav' ? '目录' : 'Artist/Album'))
            : isPlaylist
                ? `${item.songCount || 0} 首歌曲${item.owner ? ' · ' + item.owner : ''}`
                : (isMusicFile
                    ? (item.artist ? item.artist + ' - ' : '') + (item.album || (item.size ? (item.size / 1024 / 1024).toFixed(2) + ' MB' : ''))
                    : '非音乐文件')
        
        // Front section (Icon or Checkbox)
        let leadingHtml = ''
        if (isSelectMode && isMusicFile) {
            leadingHtml = `<input type="checkbox" class="checkbox-custom" ${isSelected ? 'checked' : ''} style="pointer-events:none;margin-right:12px;">`
        } else {
            leadingHtml = `<span class="material-symbols-outlined" style="color:${color};margin-right:12px">${icon}</span>`
        }

        // Trailing section (Import button)
        let trailingHtml = ''
        if (isPlaylist || isMusicFile) {
            if (isPlaylist) {
                trailingHtml = `<button class="btn-icon btn-import-playlist" title="添加此服务器歌单到 Songloft 歌单" style="color:var(--md-primary);"><span class="material-symbols-outlined">playlist_add</span></button>`
            } else {
                trailingHtml = `<button class="btn-icon btn-import-single" title="导入此曲" style="color:var(--md-primary);"><span class="material-symbols-outlined">add_circle</span></button>`
            }
        }

        el.innerHTML = `
            ${leadingHtml}
            <div style="flex:1;overflow:hidden">
                <div style="font-size:14px;color:var(--md-on-surface);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.name}</div>
                <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">${subtitle}</div>
            </div>
            ${trailingHtml}
        `
        
        const importSingleBtn = el.querySelector('.btn-import-single')
        if (importSingleBtn) importSingleBtn.onclick = (event) => {
            event.stopPropagation()
            window._importSingle(item.id)
        }
        const importPlaylistBtn = el.querySelector('.btn-import-playlist')
        if (importPlaylistBtn) importPlaylistBtn.onclick = (event) => {
            event.stopPropagation()
            importServerPlaylistToSongloft(item)
        }

        el.onclick = () => {
            if (item.type === 'directory') {
                const serverName = document.getElementById('browserServerSelect').value
            if (item.sourceType === 'dav') {
                    pathStack.push(item.id)
                    loadDirectory(serverName, item.id)
                } else {
                    pathStack.push(item.id)
                    loadDirectory(serverName, item.id)
                }
            } else if (isPlaylist) {
                loadServerPlaylistSongs(item.id, item.name)
            } else {
                if (!isMusicFile) return
                if (isSelectMode) {
                    if (isSelected) selectedItems.delete(item.id)
                    else selectedItems.set(item.id, item)
                    renderItems(items, title) // re-render this item would be better, but re-rendering all is fine for small lists
                    updateFAB()
                } else {
                    playMini(item)
                }
            }
        }
        
        container.appendChild(el)
    })
}

function updateFAB() {
    const fab = document.getElementById('fabContainer')
    if (isSelectMode && selectedItems.size > 0) {
        fab.classList.add('show')
        document.getElementById('fabSelectionCount').textContent = `已选 ${selectedItems.size} 首`
    } else {
        fab.classList.remove('show')
    }
}

function toggleSelectMode() {
    isSelectMode = !isSelectMode
    selectedItems.clear()
    const btn = document.getElementById('toggleSelectModeBtn')
    if (isSelectMode) {
        btn.innerHTML = '<span class="material-symbols-outlined">close</span> 取消选择'
        btn.style.color = 'var(--md-error)'
    } else {
        btn.innerHTML = '<span class="material-symbols-outlined">checklist</span> 多选'
        btn.style.color = 'var(--md-on-surface)'
    }
    updateFAB()
    // Re-render current list
    const title = document.getElementById('browserPathDisplay').textContent
    renderItems(currentListItems, title)
}

async function loadDirectory(serverName, dirId) {
    const container = document.getElementById('browserList')
    container.innerHTML = '<div class="empty-state">加载中...</div>'
    const server = currentServers.find(s => s.name === serverName)
    const isDav = server && server.type === 'dav'
    document.getElementById('browserUpBtn').style.display = (dirId === 'root' || dirId === '/') ? 'none' : 'block'
    
    try {
        const query = isDav ? `path=${encodeURIComponent(dirId === 'root' ? '/' : dirId)}` : `id=${encodeURIComponent(dirId)}`
        const res = await fetch(`./lists/${encodeURIComponent(serverName)}/items?${query}`, { headers: getAuthHeaders() })
        if (!res.ok) throw new Error(await res.text())
        const items = await res.json()
        currentPathId = dirId
        currentBrowserMode = 'items'
        const title = isDav
            ? (dirId === 'root' ? '/' : dirId)
            : (dirId === 'root' ? 'Artists' : (dirId === 'playlists' ? '服务器歌单' : (String(dirId).startsWith('pl-') ? '歌单歌曲' : `[ID: ${dirId}]`)))
        renderItems(items, title)
    } catch (e) {
        container.innerHTML = `<div class="empty-state" style="color:var(--md-error)">加载失败: ${e}</div>`
    }
}

async function searchSongsList() {
    const serverName = document.getElementById('browserServerSelect').value
    if (!serverName) return
    const keyword = document.getElementById('searchInput').value.trim()
    if (!keyword) return
    
    pathStack = ['root'] // reset stack
    document.getElementById('browserUpBtn').style.display = 'none'
    const container = document.getElementById('browserList')
    container.innerHTML = '<div class="empty-state">搜索中...</div>'
    
    try {
        const res = await fetch(`./lists/${encodeURIComponent(serverName)}/search?q=${encodeURIComponent(keyword)}`, { headers: getAuthHeaders() })
        if (!res.ok) throw new Error(await res.text())
        const items = await res.json()
        currentPathId = 'search'
        renderItems(items, `搜索结果: ${keyword}`)
    } catch (e) {
        container.innerHTML = `<div class="empty-state" style="color:var(--md-error)">搜索失败: ${e}</div>`
    }
}

async function fetchSpecialList(type, title) {
    const serverName = document.getElementById('browserServerSelect').value
    if (!serverName) return
    
    pathStack = ['root'] // reset stack
    document.getElementById('browserUpBtn').style.display = 'none'
    const container = document.getElementById('browserList')
    container.innerHTML = '<div class="empty-state">加载中...</div>'
    
    try {
        const res = await fetch(`./lists/${encodeURIComponent(serverName)}/${type}`, { headers: getAuthHeaders() })
        if (!res.ok) throw new Error(await res.text())
        const items = await res.json()
        currentPathId = type
        currentBrowserMode = type
        renderItems(items, title)
    } catch (e) {
        container.innerHTML = `<div class="empty-state" style="color:var(--md-error)">加载失败: ${e}</div>`
    }
}

async function loadServerPlaylists() {
    const serverName = document.getElementById('browserServerSelect').value
    if (!serverName) return
    pathStack = ['root', 'playlists']
    document.getElementById('browserUpBtn').style.display = 'block'
    await loadDirectory(serverName, 'playlists')
}

async function loadServerPlaylistSongs(playlistId, playlistName) {
    const serverName = document.getElementById('browserServerSelect').value
    if (!serverName) return
    pathStack = ['root', `playlist:${playlistId}`]
    document.getElementById('browserUpBtn').style.display = 'block'
    const container = document.getElementById('browserList')
    container.innerHTML = '<div class="empty-state">加载歌单歌曲中...</div>'
    try {
        const res = await fetch(`./lists/${encodeURIComponent(serverName)}/playlists/${encodeURIComponent(playlistId)}/items`, { headers: getAuthHeaders() })
        if (!res.ok) throw new Error(await res.text())
        const items = await res.json()
        currentPathId = `playlist:${playlistId}`
        currentBrowserMode = 'playlistSongs'
        renderItems(items, `歌单: ${playlistName}`)
    } catch (e) {
        container.innerHTML = `<div class="empty-state" style="color:var(--md-error)">加载歌单失败: ${e}</div>`
    }
}

function getPlayableItems(items = currentListItems) {
    return items.filter(isSelectableMusicItem)
}

function formatMiniTime(value) {
    const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    const minutes = Math.floor(total / 60)
    const seconds = String(total % 60).padStart(2, '0')
    return `${minutes}:${seconds}`
}

function updateMiniProgress() {
    const audio = document.getElementById('miniAudio')
    const progress = document.getElementById('miniProgress')
    const currentTime = document.getElementById('miniCurrentTime')
    const durationTime = document.getElementById('miniDuration')
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
    if (!miniProgressDragging) {
        progress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0'
    }
    currentTime.textContent = formatMiniTime(current)
    durationTime.textContent = duration > 0 ? formatMiniTime(duration) : '0:00'
}

function updateMiniPlayButton() {
    const audio = document.getElementById('miniAudio')
    const icon = document.querySelector('#miniPlayPauseBtn .material-symbols-outlined')
    if (!icon) return
    icon.textContent = audio.paused ? 'play_arrow' : 'pause'
}

function setMiniSource(item, playUrl) {
    document.getElementById('miniPlayerTitle').textContent = item.name || item.title || '未知歌曲'
    document.getElementById('miniPlayerArtist').textContent = item.artist || item.album || getServerTypeLabel(item.sourceType)
    const audio = document.getElementById('miniAudio')
    audio.src = playUrl
    document.getElementById('miniPlayer').classList.add('show')
    updateMiniProgress()
    audio.play().then(updateMiniPlayButton).catch(updateMiniPlayButton)
}

function getBestPlayUrl(item) {
    // WebDAV 源优先使用直链 URL（含认证凭据），备选代理 URL
    if ((item.sourceType || 'subsonic') === 'dav' && item.directUrl) {
        return item.directUrl
    }
    return item.streamUrl || item.url || ''
}

function playMini(item, queueItems = currentListItems) {
    const playUrl = getBestPlayUrl(item)
    if (!playUrl) {
        showSnackbar('该歌曲没有可播放地址')
        return
    }
    const queue = getPlayableItems(queueItems)
    miniQueue = queue.length > 0 ? queue : [item]
    miniQueueIndex = miniQueue.findIndex(song => song.id === item.id)
    if (miniQueueIndex < 0) miniQueueIndex = 0
    miniHandlingError = false
    setMiniSource(item, playUrl)
}

function playMiniAtIndex(index) {
    if (index < 0 || index >= miniQueue.length) return false
    miniQueueIndex = index
    const item = miniQueue[miniQueueIndex]
    const playUrl = getBestPlayUrl(item)
    if (!playUrl) return playMiniAtIndex(index + 1)
    miniHandlingError = false
    setMiniSource(item, playUrl)
    return true
}

function playNextMini() {
    if (!playMiniAtIndex(miniQueueIndex + 1)) {
        showSnackbar('播放列表已结束')
    }
}

function playPrevMini() {
    const audio = document.getElementById('miniAudio')
    if (audio.currentTime > 3) {
        audio.currentTime = 0
        updateMiniProgress()
        return
    }
    if (!playMiniAtIndex(miniQueueIndex - 1)) {
        audio.currentTime = 0
        updateMiniProgress()
    }
}

function toggleMiniPlayPause() {
    const audio = document.getElementById('miniAudio')
    if (!audio.src) return
    if (audio.paused) {
        audio.play().then(updateMiniPlayButton).catch(updateMiniPlayButton)
    } else {
        audio.pause()
        updateMiniPlayButton()
    }
}

async function tryMiniFallback(item) {
    // WebDAV 源：如果直链播放失败，尝试代理 URL
    if ((item.sourceType || 'subsonic') === 'dav') {
        const key = `dav:${item.configName || ''}:${item.id || item.path}`
        // 如果当前用的是直链，尝试代理 URL
        if (item.directUrl && item.streamUrl && item.directUrl !== item.streamUrl) {
            if (!miniFallbackTried.has(key + ':proxy')) {
                miniFallbackTried.add(key + ':proxy')
                showSnackbar('直链播放失败，尝试代理模式...')
                setMiniSource(item, item.streamUrl)
                return true
            }
        }
        // 尝试通过 /api/music/url 重新获取播放链接
        if (!miniFallbackTried.has(key + ':resolve')) {
            miniFallbackTried.add(key + ':resolve')
            try {
                const res = await fetch('./api/music/url', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        source_data: JSON.stringify({
                            configName: item.configName,
                            path: item.id || item.path,
                            type: 'dav'
                        })
                    })
                })
                if (res.ok) {
                    const data = await res.json()
                    if (data.url) {
                        item.streamUrl = data.url
                        item.url = data.url
                        showSnackbar('已重新获取 WebDAV 播放地址')
                        setMiniSource(item, data.url)
                        return true
                    }
                }
            } catch {}
        }
        return false
    }

    // Subsonic 源：搜索其他服务器
    if (item.sourceType === 'subsonic') {
        const key = `${item.configName || ''}:${item.songId || item.id}`
        if (miniFallbackTried.has(key)) return false
        miniFallbackTried.add(key)

        const title = item.name || item.title || ''
        const artist = item.artist || ''
        const keyword = [title, artist].filter(Boolean).join(' ').trim()
        if (!keyword) return false

        try {
            const res = await fetch('./api/search/topone', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    keyword,
                    hint: { title, artist, duration: item.duration || 0 },
                    excludeConfigName: item.configName || '',
                    excludeSongId: item.songId || item.id || ''
                })
            })
            if (!res.ok) return false
            const data = await res.json()
            if (data.code !== 0 || !data.data || !data.data.url) return false

            item.streamUrl = data.data.url
            item.url = data.data.url
            if (data.data.source_data) {
                item.configName = data.data.source_data.configName
                item.songId = data.data.source_data.songId
                item.sourceType = data.data.source_data.type || 'subsonic'
            }
            showSnackbar('当前音源播放失败，已切换到其他远程音源')
            setMiniSource(item, data.data.url)
            return true
        } catch {
            return false
        }
    }

    return false
}

async function handleMiniPlaybackFailure() {
    if (miniHandlingError) return
    miniHandlingError = true
    const item = miniQueue[miniQueueIndex]
    if (!item) {
        miniHandlingError = false
        return
    }
    if (await tryMiniFallback(item)) {
        miniHandlingError = false
        return
    }
    if (!playMiniAtIndex(miniQueueIndex + 1)) {
        showSnackbar('当前歌曲播放失败，且没有可继续播放的下一首')
        miniHandlingError = false
    }
}

function closeMiniPlayer() {
    const audio = document.getElementById('miniAudio')
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    miniQueue = []
    miniQueueIndex = -1
    miniHandlingError = false
    document.getElementById('miniPlayer').classList.remove('show')
    updateMiniProgress()
    updateMiniPlayButton()
}

async function createSongloftPlaylist(name, items, description) {
    const songs = await submitImport(items)
    const songIds = songs.map(s => s.id)
    const playlistRes = await fetch(window.location.origin + '/api/v1/playlists', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name, description, type: 'normal' })
    })
    if (!playlistRes.ok) throw new Error('创建歌单失败')
    const playlist = await playlistRes.json()
    if (songIds.length > 0) {
        const addRes = await fetch(window.location.origin + `/api/v1/playlists/${playlist.id}/songs`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ song_ids: songIds })
        })
        if (!addRes.ok) throw new Error('添加歌曲到歌单失败')
    }
    return songIds.length
}

async function loadSongloftPlaylistsForDialog() {
    const selectEl = document.getElementById('playlistSelect')
    // 保留第一项“＋ 新建歌单”
    selectEl.innerHTML = '<option value="__new__">＋ 新建歌单</option>'
    try {
        const res = await fetch(window.location.origin + '/api/v1/playlists', { headers: getAuthHeaders() })
        if (res.ok) {
            const playlists = await res.json()
            const list = Array.isArray(playlists) ? playlists : (playlists.playlists || playlists.data || [])
            list.forEach(p => {
                const opt = document.createElement('option')
                opt.value = p.id
                const songCount = p.song_count ?? p.songCount ?? 0
                opt.textContent = `${p.name}（${songCount}首）`
                selectEl.appendChild(opt)
            })
        }
    } catch (e) {
        console.warn('加载歌单列表失败:', e)
    }
    // 默认选中新建
    selectEl.value = '__new__'
    document.getElementById('newPlaylistNameGroup').style.display = ''
}

async function importServerPlaylistToSongloft(playlist) {
    showProgress(true, '添加服务器歌单', `正在读取并添加「${playlist.name}」...`)
    try {
        await loadServerPlaylistSongs(playlist.id, playlist.name)
        const count = await createSongloftPlaylist(playlist.name, currentListItems, 'Imported from media server playlist')
        showProgress(false)
        showSnackbar(`已添加 ${count} 首歌曲到 Songloft 歌单`)
    } catch (e) {
        showProgress(false)
        showSnackbar('添加歌单失败: ' + e.message)
    }
}

// 核心入库逻辑
async function submitImport(itemsToImport) {
    const serverName = document.getElementById('browserServerSelect').value
    if (!serverName) return null
    const server = currentServers.find(s => s.name === serverName) || {}
    const sourceType = server.type || 'subsonic'
    const musicItems = itemsToImport.filter(isSelectableMusicItem)
    if (musicItems.length === 0) throw new Error('无音乐文件可导入')
    
    const reqs = musicItems.map(item => ({
        url: item.streamUrl || item.url || '',
        title: item.name,
        artist: item.artist || (sourceType === 'dav' ? '未知歌手' : 'Unknown'),
        album: item.album || '',
        cover_url: item.coverArt || '',
        duration: item.duration || 0,
        plugin_entry_path: 'media-server',
        source_data: JSON.stringify(sourceType === 'dav'
            ? { configName: serverName, path: item.id, type: 'dav' }
            : { configName: serverName, songId: item.id, type: 'subsonic' }),
        dedup_key: `${sourceType}_${serverName}_${item.id}`
    }))
    
    try {
        // We use absolute path to hit the core API (which is hosted at the root)
        // Since the plugin is at /api/v1/jsplugin/subsonic, the root is 4 levels up.
        // It's safer to use origin
        const coreApiUrl = window.location.origin + '/api/v1/songs/remote'
        const res = await fetch(coreApiUrl, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(reqs)
        })
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        return data.songs || []
    } catch (e) {
        console.error('Import failed', e)
        throw e
    }
}

window._importSingle = async function(id) {
    const item = currentListItems.find(i => i.id === id)
    if (!item) return
    if (!isSelectableMusicItem(item)) {
        showSnackbar('非音乐文件不可导入')
        return
    }
    showProgress(true, '导入中', '正在将歌曲存入曲库...')
    try {
        await submitImport([item])
        showProgress(false)
        showSnackbar('单曲导入成功！')
    } catch (e) {
        showProgress(false)
        showSnackbar('导入失败: ' + e.message)
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab-item').forEach(btn => {
        btn.onclick = () => switchTab(btn.dataset.tab)
    })
    
    document.getElementById('refreshBtn').onclick = fetchServers
    document.getElementById('testServerBtn').onclick = testServer
    document.getElementById('addServerBtn').onclick = addServer
    document.getElementById('cancelEditBtn').onclick = closeEditDialog
    document.getElementById('saveEditBtn').onclick = saveEditServer
    document.getElementById('serverType').onchange = () => updateServerTypeFields()
    document.getElementById('editType').onchange = () => updateServerTypeFields('edit')
    updateServerTypeFields()
    
    document.getElementById('browserServerSelect').onchange = (e) => {
        const val = e.target.value
        if (val) {
            document.getElementById('discoveryArea').style.display = 'flex'
            document.getElementById('toggleSelectModeBtn').style.display = 'block'
            updateBrowserActionsVisibility()
            pathStack = ['root']
            const server = currentServers.find(s => s.name === val)
            loadDirectory(val, server && server.type === 'dav' ? '/' : 'root')
        } else {
            document.getElementById('browserList').innerHTML = '<div class="empty-state">请选择服务器进行浏览</div>'
            document.getElementById('discoveryArea').style.display = 'none'
            document.getElementById('toggleSelectModeBtn').style.display = 'none'
            if(isSelectMode) toggleSelectMode()
        }
    }
    
    document.getElementById('browserUpBtn').onclick = () => {
        const server = document.getElementById('browserServerSelect').value
        if (!server || pathStack.length <= 1) return
        pathStack.pop() // remove current
        const parentId = pathStack[pathStack.length - 1]
        loadDirectory(server, parentId)
    }

    // Discovery UI
    document.getElementById('searchBtn').onclick = searchSongsList
    document.getElementById('searchInput').onkeydown = (e) => {
        if (e.key === 'Enter') searchSongsList()
    }
    document.getElementById('chipPlaylists').onclick = loadServerPlaylists
    document.getElementById('chipStarred').onclick = () => fetchSpecialList('starred', '我的收藏')
    document.getElementById('chipRandom').onclick = () => fetchSpecialList('random', '随便听听')
    document.getElementById('miniPlayerCloseBtn').onclick = closeMiniPlayer
    const miniAudio = document.getElementById('miniAudio')
    const miniProgress = document.getElementById('miniProgress')
    miniAudio.addEventListener('timeupdate', updateMiniProgress)
    miniAudio.addEventListener('durationchange', updateMiniProgress)
    miniAudio.addEventListener('loadedmetadata', updateMiniProgress)
    miniAudio.addEventListener('ended', playNextMini)
    miniAudio.addEventListener('error', handleMiniPlaybackFailure)
    miniAudio.addEventListener('play', updateMiniPlayButton)
    miniAudio.addEventListener('pause', updateMiniPlayButton)
    document.getElementById('miniPrevBtn').onclick = playPrevMini
    document.getElementById('miniPlayPauseBtn').onclick = toggleMiniPlayPause
    document.getElementById('miniNextBtn').onclick = playNextMini
    miniProgress.addEventListener('input', () => {
        miniProgressDragging = true
        const duration = Number.isFinite(miniAudio.duration) ? miniAudio.duration : 0
        document.getElementById('miniCurrentTime').textContent = formatMiniTime(duration * (Number(miniProgress.value) / 1000))
    })
    miniProgress.addEventListener('change', () => {
        const duration = Number.isFinite(miniAudio.duration) ? miniAudio.duration : 0
        if (duration > 0) miniAudio.currentTime = duration * (Number(miniProgress.value) / 1000)
        miniProgressDragging = false
        updateMiniProgress()
    })
    
    // Select Mode & FAB
    document.getElementById('toggleSelectModeBtn').onclick = toggleSelectMode
    document.getElementById('fabCancelBtn').onclick = toggleSelectMode
    
    document.getElementById('fabImportBtn').onclick = async () => {
        if (selectedItems.size === 0) return
        showProgress(true, '批量导入', `正在导入 ${selectedItems.size} 首歌曲...`)
        try {
            await submitImport(Array.from(selectedItems.values()))
            showProgress(false)
            showSnackbar(`成功导入 ${selectedItems.size} 首歌曲`)
            toggleSelectMode() // exit select mode
        } catch (e) {
            showProgress(false)
            showSnackbar('导入失败: ' + e.message)
        }
    }

    document.getElementById('fabPlaylistBtn').onclick = async () => {
        if (selectedItems.size === 0) return
        document.getElementById('playlistName').value = ''
        // 加载已有歌单列表
        await loadSongloftPlaylistsForDialog()
        document.getElementById('playlistDialog').classList.add('show')
    }
    document.getElementById('cancelPlaylistBtn').onclick = () => {
        document.getElementById('playlistDialog').classList.remove('show')
    }
    // 歌单选择器切换时显示/隐藏名称输入框
    document.getElementById('playlistSelect').onchange = () => {
        const isNew = document.getElementById('playlistSelect').value === '__new__'
        document.getElementById('newPlaylistNameGroup').style.display = isNew ? '' : 'none'
    }
    
    document.getElementById('confirmPlaylistBtn').onclick = async () => {
        const selectEl = document.getElementById('playlistSelect')
        const selectedValue = selectEl.value
        const isNew = selectedValue === '__new__'
        
        if (isNew) {
            // 新建歌单
            const name = document.getElementById('playlistName').value.trim()
            if (!name) { showSnackbar('请输入歌单名称'); return }
            document.getElementById('playlistDialog').classList.remove('show')
            showProgress(true, '创建歌单', `正在导入歌曲并创建歌单...`)
            try {
                const count = await createSongloftPlaylist(name, Array.from(selectedItems.values()), 'Imported from media server')
                showProgress(false)
                showSnackbar(`成功创建歌单并导入 ${count} 首歌曲`)
                toggleSelectMode()
            } catch (e) {
                showProgress(false)
                showSnackbar('操作失败: ' + e.message)
            }
        } else {
            // 追加到已有歌单
            const playlistId = selectedValue
            const playlistName = selectEl.options[selectEl.selectedIndex].textContent
            document.getElementById('playlistDialog').classList.remove('show')
            showProgress(true, '导入歌单', `正在将歌曲追加到「${playlistName}」...`)
            try {
                const songs = await submitImport(Array.from(selectedItems.values()))
                const songIds = songs.map(s => s.id)
                if (songIds.length > 0) {
                    const addRes = await fetch(window.location.origin + `/api/v1/playlists/${playlistId}/songs`, {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: JSON.stringify({ song_ids: songIds })
                    })
                    if (!addRes.ok) throw new Error('添加歌曲到歌单失败')
                }
                showProgress(false)
                showSnackbar(`成功追加 ${songIds.length} 首歌曲到「${playlistName}」`)
                toggleSelectMode()
            } catch (e) {
                showProgress(false)
                showSnackbar('操作失败: ' + e.message)
            }
        }
    }

    // === 服务端模式 ===
    async function loadServerConfig() {
        try {
            const res = await fetch('server/config', { headers: getAuthHeaders() })
            if (res.ok) {
                const data = await res.json()
                document.getElementById('serverEnabled').checked = data.enabled
                document.getElementById('serverUsername').value = data.username || ''
            }
        } catch {}
        // 显示稳定的插件根地址，Subsonic 客户端会在此地址后追加 /rest 接口。
        const base = getPluginBaseUrl()
        document.getElementById('serverUrl').textContent = base
    }

    document.getElementById('saveServerModeBtn').addEventListener('click', async () => {
        const enabled = document.getElementById('serverEnabled').checked
        const username = document.getElementById('serverUsername').value.trim()
        const password = document.getElementById('serverPassword').value
        if (enabled && !password && !username) {
            showSnackbar('请设置用户名和密码')
            return
        }
        const body = { enabled, username: username || 'admin' }
        if (password) body.password = password
        try {
            const res = await fetch('server/config', {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify(body)
            })
            if (res.ok) {
                showSnackbar('服务端配置已保存')
            } else {
                showSnackbar('保存失败')
            }
        } catch (e) {
            showSnackbar('保存失败: ' + e.message)
        }
    })

    document.getElementById('copyUrlBtn').addEventListener('click', () => {
        const text = document.getElementById('serverUrl').textContent
        navigator.clipboard.writeText(text).then(() => showSnackbar('已复制连接地址'))
    })

    // tab 切换时加载服务端配置
    document.querySelectorAll('.tab-item').forEach(el => {
        el.addEventListener('click', () => {
            if (el.dataset.tab === 'server-mode') loadServerConfig()
        })
    })

    fetchServers()
})

