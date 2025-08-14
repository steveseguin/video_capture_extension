let activeStreams = new Map();
let currentTab = null;

document.addEventListener('DOMContentLoaded', async () => {
    currentTab = await getCurrentTab();
    
    initializeTabs();
    loadSettings();
    await syncWithBackground();
    loadActiveStreams();
    refreshVideos();
    updateActiveStreams();
    
    document.getElementById('refreshBtn').addEventListener('click', refreshVideos);
    document.getElementById('captureTabBtn').addEventListener('click', captureTab);
    document.getElementById('vdoServer').addEventListener('change', handleServerChange);
});

async function syncWithBackground() {
    // Get active streams from background script
    const response = await chrome.runtime.sendMessage({ type: 'getActiveStreams' });
    
    if (response && Array.isArray(response)) {
        console.log('Syncing with background streams:', response);
        
        // Clear local streams first to avoid stale entries
        activeStreams.clear();
        
        response.forEach(stream => {
            // Only add streams for current tab or tab captures
            if (stream.tabId === currentTab.id || stream.id.startsWith('tab-')) {
                activeStreams.set(stream.id, {
                    streamId: stream.streamId,
                    roomId: stream.roomId,
                    title: stream.title,
                    links: stream.links,
                    tabId: stream.tabId,
                    timestamp: stream.timestamp || Date.now()
                });
            }
        });
        
        saveActiveStreams();
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
    videoList.innerHTML = '<div class="loading">Scanning for videos...</div>';
    
    try {
        const videos = await chrome.tabs.sendMessage(currentTab.id, { type: 'detectVideos' });
        
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
            const screenshot = await chrome.tabs.sendMessage(currentTab.id, {
                type: 'captureScreenshot',
                videoId: video.id
            });
            
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
                    `<button class="btn primary-btn" data-action="stream">Publish Video</button>`
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
            await startStream(video);
            break;
        case 'stop':
            await stopStream(video.id);
            break;
        case 'view':
            viewStreamLinks(video.id);
            break;
    }
}

async function startStream(video) {
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
            timestamp: Date.now()
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
            settings: settings,
            title: video.title
        });
        
        console.log('Stream response:', response);
        
        if (response.success) {
            const streamData = {
                streamId: response.streamId,
                roomId: response.roomId,
                title: video.title,
                links: response.links,
                tabId: currentTab.id,
                pageUrl: currentTab.url,
                timestamp: Date.now()
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
    const response = await chrome.runtime.sendMessage({
        type: 'stopStream',
        videoId: videoId,
        tabId: currentTab.id
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
            timestamp: Date.now()
        });
        
        saveActiveStreams();
        updateActiveStreams();
        showNotification('Tab capture started');
        
        document.getElementById('captureTabBtn').textContent = 'Stop Tab Capture';
        document.getElementById('captureTabBtn').onclick = () => stopTabCapture();
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

function updateActiveStreams() {
    const container = document.getElementById('activeStreams');
    
    if (activeStreams.size === 0) {
        container.innerHTML = '<div class="empty-state">No active streams</div>';
        return;
    }
    
    container.innerHTML = '';
    
    activeStreams.forEach((stream, id) => {
        const div = document.createElement('div');
        div.className = 'stream-item';
        
        div.innerHTML = `
            <div class="stream-header">
                <div class="stream-title">${stream.title}</div>
                <div class="stream-badge">LIVE</div>
            </div>
            <div class="stream-links">
                ${stream.links.map(link => `
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
        
        div.querySelector('.danger-btn').addEventListener('click', () => {
            if (id.startsWith('tab-')) {
                stopTabCapture();
            } else {
                stopStream(id);
            }
        });
        
        container.appendChild(div);
    });
}

function getSettings() {
    const server = document.getElementById('vdoServer').value;
    const customServer = document.getElementById('customServer').value;
    
    return {
        roomId: document.getElementById('roomId').value || null,
        streamId: document.getElementById('streamId').value || null,
        server: server === 'custom' ? customServer : server,
        bitrate: document.getElementById('bitrate').value || null,
        codec: document.getElementById('codec').value || null,
        sharper: document.getElementById('sharper').checked,
        proaudio: document.getElementById('proaudio').checked
    };
}

function loadSettings() {
    chrome.storage.local.get(['roomId', 'streamId', 'server'], (data) => {
        if (data.roomId) document.getElementById('roomId').value = data.roomId;
        if (data.streamId) document.getElementById('streamId').value = data.streamId;
        if (data.server) {
            if (data.server.includes('vdo.ninja') || data.server.includes('socialstream')) {
                document.getElementById('vdoServer').value = data.server;
            } else {
                document.getElementById('vdoServer').value = 'custom';
                document.getElementById('customServer').value = data.server;
                document.getElementById('customServer').style.display = 'block';
            }
        }
    });
    
    ['roomId', 'streamId'].forEach(id => {
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