const activePublishers = new Map();
const activeTabs = new Map();
const pendingVideoStarts = new Map();
let pendingTabCapture = null;
let offscreenCreation = null;

function ensureOffscreenDocument() {
    if (offscreenCreation) return offscreenCreation;
    offscreenCreation = (async () => {
        const url = chrome.runtime.getURL('offscreen.html');
        const contexts = chrome.runtime.getContexts
            ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })
            : (await clients.matchAll()).filter(client => client.url === url);
        if (!contexts.length) {
            // Resolves after the initial page load, so no arbitrary delay is needed.
            await chrome.offscreen.createDocument({
                url: 'offscreen.html', reasons: ['USER_MEDIA'],
                justification: 'Tab capture requires getUserMedia in offscreen document'
            });
        }
    })().finally(() => { offscreenCreation = null; });
    return offscreenCreation;
}

// Session storage survives worker suspension, but clears when the browser or
// extension restarts, when the publishers themselves no longer exist.
const stateReady = chrome.storage.session.get('publisherState').then(({ publisherState }) => {
    for (const [id, publisher] of publisherState?.videos || []) activePublishers.set(id, publisher);
    for (const [id, capture] of publisherState?.tabs || []) activeTabs.set(id, capture);
});
let stateWrite = Promise.resolve();
function savePublisherState() {
    const publisherState = { videos: [...activePublishers], tabs: [...activeTabs] };
    stateWrite = stateWrite.catch(() => {}).then(() => chrome.storage.session.set({ publisherState }));
    return stateWrite;
}
const stateMutations = new Set(['startStream', 'stopStream', 'publisherEnded', 'tabCaptureEnded', 'captureTab', 'stopTabCapture']);

function generateStreamId() {
    return 'stream_' + Math.random().toString(36).substr(2, 9);
}

function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
}

function normalizePublisherIds(settings = {}) {
    // Match the bundled SDK's ID rules before storing IDs or building links.
    // Tests compare these results with the SDK's own normalization methods.
    const stream = typeof settings.streamId === 'string' ? settings.streamId.trim() : '';
    const room = settings.roomId == null || settings.roomId === false ? '' : String(settings.roomId).trim();
    return {
        streamId: stream ? stream.replace(/[\W]+/g, '_').slice(0, 64) : generateStreamId(),
        roomId: room.replace(/[\W]+/g, '_').slice(0, 30)
    };
}

function getVdoLinks(server, roomId, streamId, qualitySettings = {}) {
    // Determine the base viewer hostname
    let baseUrl;
    try {
        const s = (server || '').toString();
        if (s.includes('apibackup.vdo.ninja')) {
            // When using the backup websocket server, viewer links use backup.vdo.ninja
            baseUrl = 'https://backup.vdo.ninja';
        } else if (s.includes('://')) {
            baseUrl = s.replace(/\/$/, '');
        } else if (s) {
            baseUrl = ('https://' + s).replace(/\/$/, '');
        } else {
            baseUrl = 'https://vdo.ninja';
        }
    } catch (_) {
        baseUrl = 'https://vdo.ninja';
    }
    const links = [];
    
    // Build quality parameters
    let qualityParams = '';
    if (qualitySettings.bitrate) {
        qualityParams += `&bitrate=${encodeURIComponent(qualitySettings.bitrate)}`;
    }
    if (qualitySettings.codec) {
        qualityParams += `&codec=${encodeURIComponent(qualitySettings.codec)}`;
    }
    if (qualitySettings.sharper) {
        qualityParams += '&sharper';
    }
    if (qualitySettings.proaudio) {
        qualityParams += '&proaudio';
    }
    if (qualitySettings.showlabel) {
        qualityParams += '&showlabel';
    }
    
    if (roomId && roomId.trim() !== '') {
        links.push({
            label: 'Direct View',
            url: `${baseUrl}/?view=${encodeURIComponent(streamId)}&room=${encodeURIComponent(roomId)}&solo${qualityParams}`
        });
        links.push({
            label: 'Room View',
            url: `${baseUrl}/?room=${encodeURIComponent(roomId)}&scene${qualityParams}`
        });
    } else {
        links.push({
            label: 'Direct View',
            url: `${baseUrl}/?view=${encodeURIComponent(streamId)}${qualityParams}`
        });
    }
    
    return links;
}

// SDK injection not needed - already loaded via content scripts

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target === 'offscreen' || request.type === 'getTabThumbnail') return false;
    const maybePromise = stateReady.then(async () => {
        try {
            return await handleMessage(request, sender);
        } finally {
            if (stateMutations.has(request.type)) await savePublisherState();
        }
    });
    if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((resp) => {
            if (resp !== '__NO_RESPONSE__') sendResponse(resp);
        }).catch(error => sendResponse({ success: false, error: error.message }));
    } else {
        if (maybePromise !== '__NO_RESPONSE__') sendResponse(maybePromise);
    }
    return true;
});

async function handleMessage(request, sender) {
    switch(request.type) {
        case 'startStream':
            return await startVideoStream(request);
            
        case 'stopStream':
            return await stopVideoStream(request);

        case 'publisherEnded':
            // Page-level publisher cleaned up; remove our bookkeeping
            if (request && request.videoId && activePublishers.has(request.videoId)) {
                activePublishers.delete(request.videoId);
            }
            return { success: true };

        case 'tabCaptureEnded':
            if (pendingTabCapture?.tabId === request.tabId) pendingTabCapture.cancelled = true;
            activeTabs.delete(request.tabId);
            return { success: true };

        case 'getStreamThumbnail':
            return await getStreamThumbnail(request);
            
        case 'getTabThumbnail':
            // Allow offscreen document to respond to this request
            return '__NO_RESPONSE__';

        case 'captureTab':
            return await startTabCapture(request);
            
        case 'stopTabCapture':
            return await stopTabCapture(request);
            
        case 'getActiveStreams':
            return getActiveStreams();
            
        case 'checkExistingStream':
            // Check if we already have this stream published
            return checkExistingStream(request);
            
        default:
            return { error: 'Unknown request type' };
    }
}

async function getStreamThumbnail(request) {
    const { tabId, frameId, streamId } = request;
    if (!tabId || !streamId) return { success: false, error: 'Missing tabId or streamId' };
    try {
        const requestId = Math.random().toString(36).slice(2);
        const [result] = await chrome.scripting.executeScript({
            target: frameId == null ? { tabId } : { tabId, frameIds: [frameId] },
            func: async (streamId, requestId) => {
                return new Promise((resolve) => {
                    // Wait briefly for bridge readiness
                    let waited = 0;
                    const waitStep = 50;
                    const maxWait = 3000;
                    const waitForReady = (cb) => {
                        try {
                            if (window.vdoPublisherReady || typeof window.publishVideoToVDO === 'function') {
                                cb();
                                return;
                            }
                        } catch (e) {}
                        if (waited >= maxWait) { cb(); return; }
                        waited += waitStep;
                        setTimeout(() => waitForReady(cb), waitStep);
                    };
                    const responseHandler = (event) => {
                        const detail = event.detail || {};
                        if (detail.requestId !== requestId) return;
                        window.removeEventListener('vdo-thumb-response', responseHandler);
                        resolve(detail);
                    };
                    window.addEventListener('vdo-thumb-response', responseHandler);
                    window.dispatchEvent(new CustomEvent('vdo-thumb-request', { detail: { streamId, requestId } }));
                    setTimeout(() => {
                        window.removeEventListener('vdo-thumb-response', responseHandler);
                        resolve({ requestId, success: false, error: 'Thumbnail request timed out' });
                    }, 2000);
                });
            },
            args: [streamId, requestId]
        });
        const detail = result?.result || result;
        if (detail && detail.success) {
            return { success: true, dataUrl: detail.dataUrl };
        }
        return { success: false, error: detail?.error || 'Unknown error' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function checkExistingStream(request) {
    const { videoId } = request;
    const publisher = activePublishers.get(videoId);
    
    if (publisher) {
        return {
            exists: true,
            streamId: publisher.streamId,
            roomId: publisher.roomId,
            links: getVdoLinks(publisher.server, publisher.roomId, publisher.streamId, publisher.qualitySettings)
        };
    }
    
    return { exists: false };
}

async function startVideoStream(request) {
    if (pendingVideoStarts.has(request.videoId)) return pendingVideoStarts.get(request.videoId);
    const pending = createVideoStream(request);
    pendingVideoStarts.set(request.videoId, pending);
    try {
        return await pending;
    } finally {
        pendingVideoStarts.delete(request.videoId);
    }
}

async function createVideoStream(request) {
    const { videoId, tabId, frameId, settings, title } = request;
    
    // Check if we already have this stream active
    if (activePublishers.has(videoId)) {
        console.log('Stream already active for:', videoId);
        const publisher = activePublishers.get(videoId);
        return {
            success: true,
            streamId: publisher.streamId,
            roomId: publisher.roomId,
            links: getVdoLinks(publisher.server, publisher.roomId, publisher.streamId, publisher.qualitySettings)
        };
    }
    
    try {
        
        
        // Check if SDK already injected
        const [checkResult] = await chrome.scripting.executeScript({
            target: frameId ? { tabId: tabId, frameIds: [frameId] } : { tabId: tabId },
            func: () => window.vdoFullyLoaded
        });
        
        if (!checkResult.result) {
            // Inject the SDK loader
            console.warn('VDO not fully loaded after 5 seconds, proceeding anyway');
        }
        
        const { streamId, roomId } = normalizePublisherIds(settings);
        const server = settings.server || 'vdo.ninja';
        const requestId = crypto.randomUUID();
        
        // Use event-based communication to call publisher functions
        const [result] = await chrome.scripting.executeScript({
            target: frameId ? { tabId: tabId, frameIds: [frameId] } : { tabId: tabId },
            func: async (videoId, streamId, roomId, title, password, server, mic, qualitySettings, requestId) => {
                
                return new Promise((resolve) => {
                    // Set up response listener
                    const responseHandler = (event) => {
                        if (event.detail?.requestId !== requestId) return;
                        clearTimeout(timeout);
                        window.removeEventListener('vdo-publish-response', responseHandler);
                        resolve(event.detail);
                    };
                    window.addEventListener('vdo-publish-response', responseHandler);
                    
                    // Timeout after 10 seconds
                    const timeout = setTimeout(() => {
                        window.removeEventListener('vdo-publish-response', responseHandler);
                        window.dispatchEvent(new CustomEvent('vdo-cancel-publish-request', { detail: { requestId } }));
                        resolve({ success: false, error: 'Publish request timed out after 10 seconds' });
                    }, 10000);
                    window.dispatchEvent(new CustomEvent('vdo-publish-request', {
                        detail: { requestId, videoId, streamId, roomId, title, password, server, mic, qualitySettings }
                    }));
                });
            },
            args: [videoId, streamId, roomId, title, settings.password || '', server, request.mic || { include: false }, settings, requestId]
        });
        
        if (!result || !result.result || !result.result.success) {
            throw new Error(result?.result?.error || 'Failed to create publisher');
        }
        
        // Store the publisher info
        activePublishers.set(videoId, {
            streamId: streamId,
            roomId: roomId,
            server: server,
            tabId: tabId,
            frameId: frameId || null,
            title: title,
            qualitySettings: settings,
            timestamp: Date.now()
        });
        
        return {
            success: true,
            streamId: streamId,
            roomId: roomId,
            links: getVdoLinks(server, roomId, streamId, settings)
        };
        
    } catch (error) {
        console.error('Error starting video stream:', error);
        return { success: false, error: error.message };
    }
}

async function stopVideoStream(request) {
    const { videoId } = request;
    if (pendingVideoStarts.has(videoId)) await pendingVideoStarts.get(videoId);
    
    const publisher = activePublishers.get(videoId);
    if (!publisher) {
        return { success: false, error: 'Stream not found' };
    }
    const tabId = publisher.tabId;
    
    try {
        // Best-effort stop in the original tab when available
        if (tabId) {
            try {
                const [result] = await chrome.scripting.executeScript({
                    target: (publisher.frameId != null) ? { tabId: tabId, frameIds: [publisher.frameId] } : { tabId: tabId },
                    func: async (streamId, requestId) => {
                        return new Promise((resolve) => {
                            const responseHandler = (event) => {
                                if (event.detail?.requestId !== requestId) return;
                                clearTimeout(timeout);
                                window.removeEventListener('vdo-stop-response', responseHandler);
                                resolve(event.detail);
                            };
                            window.addEventListener('vdo-stop-response', responseHandler);
                            const timeout = setTimeout(() => {
                                window.removeEventListener('vdo-stop-response', responseHandler);
                                resolve({ success: false, error: 'Stop request timed out' });
                            }, 5000);
                            window.dispatchEvent(new CustomEvent('vdo-stop-request', { detail: { streamId, requestId } }));
                        });
                    },
                    args: [publisher.streamId, crypto.randomUUID()]
                });
                if (!result?.result?.success) {
                    return { success: false, error: result?.result?.error || 'Failed to stop publisher' };
                }
            } catch (e) {
                // A closed tab cannot retain a publisher. Otherwise keep its
                // controls available so a failed stop can be retried.
                try {
                    await chrome.tabs.get(tabId);
                    return { success: false, error: e.message };
                } catch (_) {
                    activePublishers.delete(videoId);
                    return { success: true };
                }
            }

            try {
                await chrome.tabs.sendMessage(tabId, { type: 'stopCapture', videoId: videoId }, publisher.frameId == null ? {} : { frameId: publisher.frameId });
            } catch (e) {
                // Content script might be gone; ignore
            }
        }

        activePublishers.delete(videoId);
        return { success: true };
    } catch (error) {
        console.error('Error stopping stream:', error);
        return { success: false, error: error.message };
    }
}

async function startTabCapture(request) {
    if (pendingTabCapture) return { success: false, error: 'A tab capture is already starting' };
    const pending = { tabId: request.tabId, cancelled: false };
    pendingTabCapture = pending;
    try {
        return await createTabCapture(request, pending);
    } finally {
        if (pendingTabCapture === pending) pendingTabCapture = null;
    }
}

async function createTabCapture(request, pending) {
    const { tabId, audio, video, settings } = request;
    
    // Get tab info for title
    
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!audio && !video) return { success: false, error: 'Select audio or video to capture' };
        if (activeTabs.size) return { success: false, error: 'Stop the current tab capture before starting another' };
        const { streamId, roomId } = normalizePublisherIds(settings);
        const server = settings.server || 'vdo.ninja';
        
        // Get media stream ID for tab capture (Manifest V3)
        const mediaStreamId = await new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId({
                targetTabId: tabId
            }, (streamId) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(streamId);
                }
            });
        });
        
        if (!mediaStreamId) {
            return { success: false, error: 'Failed to get media stream ID' };
        }
        if (pending.cancelled) return { success: false, error: 'Tab capture cancelled' };
        
        await ensureOffscreenDocument();
        if (pending.cancelled) return { success: false, error: 'Tab capture cancelled' };
        
        // Start tab capture in offscreen document
        
        const captureResult = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'startTabCapture',
                target: 'offscreen',
                mediaStreamId: mediaStreamId,
                audio: audio,
                video: video,
                streamId: streamId,
                roomId: roomId,
                server: server,
                settings: settings,
                tabId: tabId,
                title: tab.title || 'Tab Capture'
            }, (response) => {
                const error = chrome.runtime.lastError;
                resolve(error ? { success: false, error: error.message } : response);
            });
        });
        
        if (!captureResult || !captureResult.success) {
            return { success: false, error: captureResult?.error || 'Failed to capture tab' };
        }
        if (pending.cancelled) return { success: false, error: 'Tab capture cancelled' };
        
        // Store the active tab capture with title and settings
        activeTabs.set(tabId, {
            mediaStreamId: mediaStreamId,
            streamId: streamId,
            roomId: roomId,
            server: server,
            title: tab.title || 'Tab Capture',
            qualitySettings: settings,
            timestamp: Date.now()
        });
        
        return {
            success: true,
            streamId: streamId,
            roomId: roomId,
            links: getVdoLinks(server, roomId, streamId, settings),
            message: 'Tab capture started successfully'
        };
        
    } catch (error) {
        console.error('Tab capture error:', error);
        return { success: false, error: error.message };
    }
}

async function stopTabCapture(request) {
    const { tabId } = request;
    const pending = pendingTabCapture?.tabId === tabId ? pendingTabCapture : null;
    if (pending) {
        pending.cancelled = true;
        try {
            await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopTabCapture', tabId });
        } catch (e) {
            // The offscreen document may not exist yet. The cancelled startup
            // checks its token before sending any start command.
        }
        if (pendingTabCapture === pending) pendingTabCapture = null;
        return { success: true };
    }
    
    const tabCapture = activeTabs.get(tabId);
    if (!tabCapture) {
        return { success: false, error: 'Tab capture not found' };
    }
    
    const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'stopTabCapture',
        tabId
    });
    if (!response?.success) return response || { success: false, error: 'No response from tab capture' };
    
    activeTabs.delete(tabId);
    
    return { success: true };
}

function getActiveStreams() {
    const streams = [];
    
    activePublishers.forEach((publisher, id) => {
        streams.push({
            id: id,
            type: 'video',
            ...publisher,
            links: getVdoLinks(publisher.server, publisher.roomId, publisher.streamId, publisher.qualitySettings)
        });
    });
    
    activeTabs.forEach((tab, tabId) => {
        streams.push({
            id: `tab-${tabId}`,
            type: 'tab',
            tabId: tabId,
            title: tab.title || `Tab ${tabId}`,
            ...tab,
            links: getVdoLinks(tab.server, tab.roomId, tab.streamId, tab.qualitySettings)
        });
    });
    
    
    return streams;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await stateReady;
    const publishers = Array.from(activePublishers.entries())
        .filter(([_, pub]) => pub.tabId === tabId);
    
    publishers.forEach(([id, _]) => {
        activePublishers.delete(id);
    });
    
    if (activeTabs.has(tabId) || pendingTabCapture?.tabId === tabId) {
        // Politely stop offscreen publisher; it will send bye and cleanup
        try {
            await stopTabCapture({ tabId });
        } catch (e) {}
        activeTabs.delete(tabId);
    }
    await savePublisherState();
});
