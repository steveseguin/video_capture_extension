let activeStreams = new Map();
let currentTab = null;

function isRestrictedUrl(url) {
    try {
        return /^(chrome:\/\/|chrome-extension:\/\/|chrome-search:\/\/|chrome-devtools:\/\/|edge:\/\/|about:|devtools:\/\/|moz-extension:\/\/)/.test(url || '');
    } catch (_) {
        return false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    currentTab = await getCurrentTab();
    
    initializeTabs();
    loadSettings();
    await syncWithBackground();
    loadActiveStreams();
    refreshVideos();
    updateActiveStreams();
    // Periodically refresh active streams to avoid stale UI
    setInterval(async () => {
        try {
            await syncWithBackground();
            updateActiveStreams();
            refreshThumbnails(true);
        } catch (e) {}
    }, 2000);
    
    document.getElementById('refreshBtn').addEventListener('click', refreshVideos);
    document.getElementById('captureTabBtn').addEventListener('click', captureTab);
    document.getElementById('vdoServer').addEventListener('change', handleServerChange);
});

async function syncWithBackground() {
    // Get active streams from background script
    const response = await chrome.runtime.sendMessage({ type: 'getActiveStreams' });
    
    if (response && Array.isArray(response)) {
        console.log('Syncing with background streams:', response);
        
        // Rebuild map from background; include all active streams
        const next = new Map();
        response.forEach(stream => {
            next.set(stream.id, {
                id: stream.id,
                streamId: stream.streamId,
                roomId: stream.roomId,
                title: stream.title,
                links: stream.links,
                tabId: stream.tabId,
                frameId: stream.frameId,
                timestamp: stream.timestamp || Date.now(),
                type: stream.type
            });
        });
        activeStreams = next;
        
        saveActiveStreams();
        refreshThumbnails();
    }
}

function initializeTabs() {
    const tabs = document.querySelectorAll('.tab');
    const contents = document.querySelectorAll('.tab-content');
    const settingsPanel = document.getElementById('settingsPanel');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.style.display = 'none');
            
            tab.classList.add('active');
            document.getElementById(`${tab.dataset.tab}-tab`).style.display = 'block';
            
            // Show settings only for Videos and Tab Capture tabs
            if (tab.dataset.tab === 'videos' || tab.dataset.tab === 'tab') {
                settingsPanel.style.display = 'block';
            } else {
                settingsPanel.style.display = 'none';
            }
        });
    });
}

async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function refreshVideos() {
    if (!currentTab) return;
    
    const videoList = document.getElementById('videoList');
    if (isRestrictedUrl(currentTab.url)) {
        videoList.innerHTML = '<div class="empty-state">This page cannot be scanned (browser internal). Open a regular website tab.</div>';
        return;
    }
    videoList.innerHTML = '<div class="loading">Scanning for videos...</div>';
    
    try {
        // Detect across all frames and annotate with frameId
        const results = await chrome.scripting.executeScript({
            target: { tabId: currentTab.id, allFrames: true },
            func: () => {
                try {
                    if (typeof detectVideos === 'function') {
                        return detectVideos();
                    }
                } catch (e) {}
                // Fallback minimal detection
                const out = [];
                const vids = document.querySelectorAll('video');
                vids.forEach((v, i) => {
                    const rect = v.getBoundingClientRect();
                    const id = v.dataset.vdoCaptureId || `video-${i}-${Date.now()}`;
                    if (!v.dataset.vdoCaptureId) v.dataset.vdoCaptureId = id;
                    out.push({
                        id,
                        index: i,
                        width: v.videoWidth || rect.width,
                        height: v.videoHeight || rect.height,
                        hasAudio: true,
                        paused: v.paused,
                        muted: v.muted,
                        title: document.title
                    });
                });
                return out;
            }
        });
        const videos = (results || []).flatMap(r => Array.isArray(r.result) ? r.result.map(v => ({ ...v, frameId: r.frameId })) : []);

        if (!videos || videos.length === 0) {
            videoList.innerHTML = '<div class="empty-state">No videos found on this page</div>';
            // Clear any streams since there are no videos
            cleanupInvalidStreams([]);
            return;
        }
        
        videoList.innerHTML = '';
        
        // Clean up streams for videos that no longer exist
        cleanupInvalidStreams(videos.map(v => v.id));
        
        for (const video of videos) {
            let screenshot = null;
            try {
                screenshot = await chrome.tabs.sendMessage(currentTab.id, {
                    type: 'captureScreenshot',
                    videoId: video.id
                }, { frameId: video.frameId });
            } catch (e) {}
            
            const videoEl = createVideoElement(video, screenshot);
            videoList.appendChild(videoEl);
        }
    } catch (error) {
        console.error('Error refreshing videos:', error);
        videoList.innerHTML = '<div class="empty-state">Error: Unable to scan page</div>';
    }
}

function cleanupInvalidStreams(validVideoIds) {
    // Don't clean up streams - they might still be valid even if video IDs changed
    // This was too aggressive and removed valid streams
    return;
}

function createVideoElement(video, screenshot) {
    const div = document.createElement('div');
    div.className = 'video-item';
    div.dataset.videoId = video.id;
    
    const isStreaming = activeStreams.has(video.id);
    
    div.innerHTML = `
        <div class="video-thumbnail">
            ${screenshot ? 
                `<img src="${screenshot}" alt="${video.title}">` : 
                '<div class="no-preview">No preview available</div>'
            }
            ${!video.paused ? '<div class="video-status live">LIVE</div>' : ''}
        </div>
        <div class="video-info">
            <div class="video-title">${video.title}</div>
            <div class="video-meta">
                <span>${video.width}x${video.height}</span>
                <span>${video.hasAudio ? '🔊 Audio' : '🔇 No Audio'}</span>
                ${video.duration && isFinite(video.duration) ? 
                    `<span>${formatDuration(video.duration)}</span>` : ''}
            </div>
            <div class="video-actions">
                ${isStreaming ? 
                    `<button class="btn danger-btn" data-action="stop">Stop Publishing</button>
                     <button class="btn secondary-btn" data-action="view">Show Links</button>` :
                    `<button class="btn primary-btn" data-action="stream">Publish Video</button>
                     <button class="btn secondary-btn" data-action="stream-mic" title="Publish with local mic">+ Mic</button>`
                }
            </div>
        </div>
    `;
    
    div.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => handleVideoAction(video, btn.dataset.action));
    });
    
    return div;
}

async function handleVideoAction(video, action) {
    switch(action) {
        case 'stream':
            await startStream(video, { includeMic: false });
            break;
        case 'stream-mic':
            await startStream(video, { includeMic: true });
            break;
        case 'stop':
            await stopStream(video.id);
            break;
        case 'view':
            viewStreamLinks(video.id);
            break;
    }
}

async function startStream(video, options = { includeMic: false }) {
    if (currentTab && isRestrictedUrl(currentTab.url)) {
        showNotification('Cannot publish from this page. Open a regular website tab.', 'error');
        alert('Cannot publish from this page. Open a regular website tab.');
        return;
    }
    // First check with background if this stream is already published
    const checkResponse = await chrome.runtime.sendMessage({
        type: 'checkExistingStream',
        videoId: video.id
    });
    
    if (checkResponse.exists) {
        // Stream already exists in background, just update our local state
        activeStreams.set(video.id, {
            streamId: checkResponse.streamId,
            roomId: checkResponse.roomId,
            title: video.title,
            links: checkResponse.links,
            tabId: currentTab.id,
            pageUrl: currentTab.url,
            timestamp: Date.now(),
            type: 'video'
        });
        saveActiveStreams();
        updateActiveStreams();
        showNotification('Using existing stream for this video');
        document.querySelector('[data-tab="active"]').click();
        return;
    }
    
    // Check if we have it locally but not in background (popup was closed)
    if (activeStreams.has(video.id)) {
        showNotification('Stream already active for this video');
        document.querySelector('[data-tab="active"]').click();
        return;
    }
    
    const settings = getSettings();
    
    console.log('Starting new stream for video:', video);
    
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'startStream',
            videoId: video.id,
            tabId: currentTab.id,
            frameId: video.frameId,
            settings: settings,
            title: video.title,
            mic: { include: !!options.includeMic }
        });
        
        console.log('Stream response:', response);
        
        if (response.success) {
            const streamData = {
                streamId: response.streamId,
                roomId: response.roomId,
                title: video.title,
                links: response.links,
                tabId: currentTab.id,
                frameId: video.frameId,
                pageUrl: currentTab.url,
                timestamp: Date.now(),
                type: 'video'
            };
            
            activeStreams.set(video.id, streamData);
            
            // Save to storage
            saveActiveStreams();
            
            refreshVideos();
            updateActiveStreams();
            
            showNotification(`Streaming started: ${video.title}`);
            
            // Switch to active streams tab to show the links
            document.querySelector('[data-tab="active"]').click();
        } else {
            showNotification(`Failed to start stream: ${response.error}`, 'error');
            alert(`Failed to start stream: ${response.error}`);
        }
    } catch (error) {
        console.error('Error starting stream:', error);
        showNotification(`Error: ${error.message}`, 'error');
        alert(`Error: ${error.message}`);
    }
}

async function stopStream(videoId) {
    const st = activeStreams.get(videoId);
    const response = await chrome.runtime.sendMessage({
        type: 'stopStream',
        videoId: videoId,
        tabId: currentTab.id,
        frameId: st?.frameId
    });
    
    if (response && response.success) {
        activeStreams.delete(videoId);
        saveActiveStreams();
        refreshVideos();
        updateActiveStreams();
        showNotification('Stream stopped');
    } else {
        // Even if background fails, clean up local state
        activeStreams.delete(videoId);
        saveActiveStreams();
        updateActiveStreams();
        showNotification('Stream removed from list');
    }
}

function saveActiveStreams() {
    const streamsArray = Array.from(activeStreams.entries()).map(([id, data]) => ({
        id,
        ...data
    }));
    
    chrome.storage.local.set({ activeStreams: streamsArray });
}

async function loadActiveStreams() {
    // Don't load from storage - only sync with background
    // This prevents stale streams from persisting
    return;
}

function viewStreamLinks(videoId) {
    const stream = activeStreams.get(videoId);
    if (!stream) {
        alert('No active stream for this video. Please start streaming first.');
        return;
    }
    
    document.querySelector('[data-tab="active"]').click();
}

async function captureTab() {
    // Check if tab capture already exists
    if (activeStreams.has(`tab-${currentTab.id}`)) {
        showNotification('Tab capture already active');
        document.querySelector('[data-tab="active"]').click();
        return;
    }
    if (currentTab && isRestrictedUrl(currentTab.url)) {
        showNotification('Tab capture is not allowed on this page', 'error');
        alert('Tab capture is not allowed on this page. Switch to a regular website tab.');
        return;
    }
    
    const captureAudio = document.getElementById('captureAudio').checked;
    const captureVideo = document.getElementById('captureVideo').checked;
    const settings = getSettings();
    
    const response = await chrome.runtime.sendMessage({
        type: 'captureTab',
        tabId: currentTab.id,
        audio: captureAudio,
        video: captureVideo,
        settings: settings
    });
    
    if (response.success) {
        activeStreams.set(`tab-${currentTab.id}`, {
            streamId: response.streamId,
            roomId: response.roomId,
            title: `Tab: ${currentTab.title}`,
            links: response.links,
            tabId: currentTab.id,
            timestamp: Date.now(),
            type: 'tab'
        });
        
        saveActiveStreams();
        updateActiveStreams();
        showNotification('Tab capture started');
        
        document.getElementById('captureTabBtn').textContent = 'Stop Tab Capture';
        document.getElementById('captureTabBtn').onclick = () => stopTabCapture();
        
        // Switch to active streams tab to show the links
        document.querySelector('[data-tab="active"]').click();
    } else {
        showNotification(`Failed to capture tab: ${response.error}`, 'error');
    }
}

async function stopTabCapture() {
    const response = await chrome.runtime.sendMessage({
        type: 'stopTabCapture',
        tabId: currentTab.id
    });
    
    if (response.success) {
        activeStreams.delete(`tab-${currentTab.id}`);
        saveActiveStreams();
        updateActiveStreams();
        
        document.getElementById('captureTabBtn').textContent = 'Start Tab Capture';
        document.getElementById('captureTabBtn').onclick = captureTab;
        
        showNotification('Tab capture stopped');
    }
}

async function stopActiveStream(id) {
    const stream = activeStreams.get(id);
    if (!stream) return;
    if (id.startsWith('tab-')) {
        const response = await chrome.runtime.sendMessage({ type: 'stopTabCapture', tabId: stream.tabId });
        if (response && response.success) {
            activeStreams.delete(id);
            saveActiveStreams();
            updateActiveStreams();
            showNotification('Tab capture stopped');
        }
        return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'stopStream', videoId: id, tabId: stream.tabId, frameId: stream.frameId });
    if (response && response.success) {
        activeStreams.delete(id);
        saveActiveStreams();
        updateActiveStreams();
        showNotification('Stream stopped');
    } else {
        // Remove from UI anyway
        activeStreams.delete(id);
        saveActiveStreams();
        updateActiveStreams();
    }
}

function updateActiveStreams() {
    const container = document.getElementById('activeStreams');
    
    if (!activeStreams || activeStreams.size === 0) {
        container.innerHTML = '<div class="empty-state">No active streams</div>';
        return;
    }
    
    container.innerHTML = '';

    // Sort by newest first
    const items = Array.from(activeStreams.entries())
        .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

    items.forEach(([id, stream]) => {
        const div = document.createElement('div');
        div.className = 'stream-item';
        const title = stream.title || (id.startsWith('tab-') ? `Tab: ${stream.tabId || id.slice(4)}` : `Video ${id}`);
        const links = Array.isArray(stream.links) ? stream.links : [];
        const thumb = stream.thumb || '';

        div.innerHTML = `
            <div class="stream-header">
                <div class="stream-head-left">
                    ${thumb ? `<img class=\"stream-thumb\" src=\"${thumb}\">` : `<div class=\"stream-thumb placeholder\"></div>`}
                    <div class="stream-title">${title}</div>
                </div>
                <div class="stream-badge">LIVE</div>
            </div>
            <div class="stream-links">
                ${links.map(link => `
                    <div class="stream-link">
                        <span>${link.label}:</span>
                        <a href="#" data-url="${link.url}" class="stream-url">${link.url}</a>
                        <button class="copy-btn" data-url="${link.url}">Copy</button>
                    </div>
                `).join('')}
            </div>
            <button class="btn danger-btn" data-stream-id="${id}">Stop Stream</button>
        `;
        
        div.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.url);
                showNotification('Link copied to clipboard');
            });
        });
        
        div.querySelectorAll('.stream-url').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                chrome.tabs.create({ url: link.dataset.url });
            });
        });
        
        div.querySelector('.danger-btn').addEventListener('click', () => stopActiveStream(id));
        
        container.appendChild(div);
    });
}

function getSettings() {
    const server = document.getElementById('vdoServer').value;
    const customServer = document.getElementById('customServer').value;
    
    return {
        roomId: document.getElementById('roomId').value || null,
        streamId: document.getElementById('streamId').value || null,
        password: document.getElementById('password').value ?? '',
        server: server === 'custom' ? customServer : server,
        bitrate: document.getElementById('bitrate').value || null,
        codec: document.getElementById('codec').value || null,
        sharper: document.getElementById('sharper').checked,
        proaudio: document.getElementById('proaudio').checked,
        showlabel: document.getElementById('showlabel').checked
    };
}

function loadSettings() {
    chrome.storage.local.get(['roomId', 'streamId', 'password', 'server', 'showlabel'], (data) => {
        if (data.roomId) document.getElementById('roomId').value = data.roomId;
        if (data.streamId) document.getElementById('streamId').value = data.streamId;
        if (data.password !== undefined) document.getElementById('password').value = data.password;
        if (data.server) {
            if (data.server.includes('vdo.ninja') || data.server.includes('socialstream')) {
                document.getElementById('vdoServer').value = data.server;
            } else {
                document.getElementById('vdoServer').value = 'custom';
                document.getElementById('customServer').value = data.server;
                document.getElementById('customServer').style.display = 'block';
            }
        }
        if (typeof data.showlabel === 'boolean') {
            document.getElementById('showlabel').checked = data.showlabel;
        }
    });
    
    ['roomId', 'streamId', 'password', 'showlabel'].forEach(id => {
        document.getElementById(id).addEventListener('change', saveSettings);
    });
}

function saveSettings() {
    const settings = getSettings();
    chrome.storage.local.set(settings);
}

function handleServerChange(e) {
    const customInput = document.getElementById('customServer');
    if (e.target.value === 'custom') {
        customInput.style.display = 'block';
    } else {
        customInput.style.display = 'none';
    }
    saveSettings();
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function showNotification(message, type = 'success') {
    console.log(`[${type}] ${message}`);
}

// Mic selector removed: Chrome prompt lets users choose a device when needed

// Thumbnail management
let thumbRefreshInFlight = false;
async function refreshThumbnails(throttle = false) {
    if (thumbRefreshInFlight) return; // avoid overlap
    thumbRefreshInFlight = true;
    try {
        const now = Date.now();
        for (const [id, stream] of activeStreams.entries()) {
            const age = now - (stream.lastThumbAt || 0);
            const needs = !stream.thumb || (!throttle && age > 0) || (throttle && age > 15000);
            if (!needs || stream.thumbPending) continue;
            stream.thumbPending = true;
            try {
                let dataUrl = null;
                if (stream.type === 'video' && stream.tabId && stream.streamId) {
                    // Prefer page-context thumbnail from publisher stream
                    try {
                        const resp = await chrome.runtime.sendMessage({ type: 'getStreamThumbnail', tabId: stream.tabId, streamId: stream.streamId });
                        if (resp && resp.success) dataUrl = resp.dataUrl;
                    } catch (e) {}
                    // Fallback to direct DOM screenshot if needed
                    if (!dataUrl) {
                        try {
                            dataUrl = await chrome.tabs.sendMessage(stream.tabId, { type: 'captureScreenshot', videoId: id });
                        } catch (e) {}
                    }
                } else if (stream.type === 'tab') {
                    try {
                        const resp = await chrome.runtime.sendMessage({ type: 'getTabThumbnail' });
                        if (resp && resp.success) dataUrl = resp.dataUrl;
                    } catch (e) {}
                }
                if (dataUrl) {
                    stream.thumb = dataUrl;
                    stream.lastThumbAt = Date.now();
                }
            } finally {
                stream.thumbPending = false;
            }
        }
    } finally {
        thumbRefreshInFlight = false;
        updateActiveStreams();
    }
}
