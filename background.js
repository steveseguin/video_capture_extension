const activePublishers = new Map();
const activeTabs = new Map();

function generateStreamId() {
    return 'stream_' + Math.random().toString(36).substr(2, 9);
}

function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
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
        qualityParams += `&bitrate=${qualitySettings.bitrate}`;
    }
    if (qualitySettings.codec) {
        qualityParams += `&codec=${qualitySettings.codec}`;
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
            url: `${baseUrl}/?view=${streamId}&room=${roomId}&solo${qualityParams}`
        });
        links.push({
            label: 'Room View',
            url: `${baseUrl}/?room=${roomId}&scene${qualityParams}`
        });
    } else {
        links.push({
            label: 'Direct View',
            url: `${baseUrl}/?view=${streamId}${qualityParams}`
        });
    }
    
    return links;
}

// SDK injection not needed - already loaded via content scripts

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const maybePromise = handleMessage(request, sender);
    if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((resp) => {
            if (resp !== '__NO_RESPONSE__') sendResponse(resp);
        });
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
    const { tabId, streamId } = request;
    if (!tabId || !streamId) return { success: false, error: 'Missing tabId or streamId' };
    try {
        const requestId = Math.random().toString(36).slice(2);
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
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
        console.log('Starting new video stream for:', videoId);
        
        // Check if SDK already injected
        const [checkResult] = await chrome.scripting.executeScript({
            target: frameId ? { tabId: tabId, frameIds: [frameId] } : { tabId: tabId },
            func: () => window.vdoFullyLoaded
        });
        
        if (!checkResult.result) {
            // Inject the SDK loader
            console.warn('VDO not fully loaded after 5 seconds, proceeding anyway');
        }
        
        const streamId = settings.streamId || generateStreamId();
        const roomId = settings.roomId || '';
        const server = settings.server || 'vdo.ninja';
        
        // Use event-based communication to call publisher functions
        const [result] = await chrome.scripting.executeScript({
            target: frameId ? { tabId: tabId, frameIds: [frameId] } : { tabId: tabId },
            func: async (videoId, streamId, roomId, title, password, server) => {
                console.log('Sending publish request via events...');
                
                return new Promise((resolve) => {
                    // Set up response listener
                    const responseHandler = (event) => {
                        console.log('Received publish response:', event.detail);
                        window.removeEventListener('vdo-publish-response', responseHandler);
                        resolve(event.detail);
                    };
                    window.addEventListener('vdo-publish-response', responseHandler);
                    
                    window.dispatchEvent(new CustomEvent('vdo-publish-request', {
                        detail: { videoId, streamId, roomId, title, password, server }
                    }));
                    
                    // Timeout after 10 seconds
                    setTimeout(() => {
                        window.removeEventListener('vdo-publish-response', responseHandler);
                        resolve({ success: false, error: 'Publish request timed out after 10 seconds' });
                    }, 10000);
                });
            },
            args: [videoId, streamId, roomId, title, settings.password || '', server]
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
    const { videoId, tabId } = request;
    
    const publisher = activePublishers.get(videoId);
    if (!publisher) {
        return { success: false, error: 'Stream not found' };
    }
    
    try {
        // Best-effort stop in the original tab when available
        if (tabId) {
            try {
                await chrome.scripting.executeScript({
                    target: (publisher.frameId) ? { tabId: tabId, frameIds: [publisher.frameId] } : { tabId: tabId },
                    func: async (streamId) => {
                        return new Promise((resolve) => {
                            const responseHandler = (event) => {
                                window.removeEventListener('vdo-stop-response', responseHandler);
                                resolve(event.detail);
                            };
                            window.addEventListener('vdo-stop-response', responseHandler);
                            window.dispatchEvent(new CustomEvent('vdo-stop-request', { detail: { streamId } }));
                            setTimeout(() => {
                                window.removeEventListener('vdo-stop-response', responseHandler);
                                resolve({ success: false, error: 'Stop request timed out' });
                            }, 5000);
                        });
                    },
                    args: [publisher.streamId]
                });
            } catch (e) {
                console.warn('Stop request script injection failed or tab unavailable:', e.message);
            }

            try {
                await chrome.tabs.sendMessage(tabId, { type: 'stopCapture', videoId: videoId }, { frameId: publisher.frameId });
            } catch (e) {
                // Content script might be gone; ignore
            }
        }

        activePublishers.delete(videoId);
        return { success: true };
    } catch (error) {
        console.error('Error stopping stream:', error);
        activePublishers.delete(videoId);
        return { success: false, error: error.message };
    }
}

async function startTabCapture(request) {
    const { tabId, audio, video, settings } = request;
    
    // Get tab info for title
    const tab = await chrome.tabs.get(tabId);
    
    try {
        const streamId = settings.streamId || generateStreamId();
        const roomId = settings.roomId || null;
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
        
        // Create offscreen document for tab capture
        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['USER_MEDIA'],
                justification: 'Tab capture requires getUserMedia in offscreen document'
            });
            console.log('Offscreen document created');
        } catch (e) {
            // Document might already exist
            console.log('Offscreen document might already exist:', e.message);
        }
        
        // Wait a moment for offscreen document to be ready
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Start tab capture in offscreen document
        console.log('Sending tab capture request to offscreen document:', { mediaStreamId, audio, video, streamId, roomId, server, settings });
        const captureResult = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'startTabCapture',
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
                console.log('Offscreen document response:', response);
                resolve(response);
            });
        });
        
        if (!captureResult || !captureResult.success) {
            return { success: false, error: captureResult?.error || 'Failed to capture tab' };
        }
        
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
    
    const tabCapture = activeTabs.get(tabId);
    if (!tabCapture) {
        return { success: false, error: 'Tab capture not found' };
    }
    
    if (tabCapture.stream) {
        tabCapture.stream.getTracks().forEach(track => track.stop());
    }
    
    await chrome.tabs.sendMessage(tabId, {
        type: 'unpublishStream',
        streamId: tabCapture.streamId
    });
    
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
    
    console.log('Returning active streams:', streams);
    return streams;
}

chrome.tabs.onRemoved.addListener((tabId) => {
    const publishers = Array.from(activePublishers.entries())
        .filter(([_, pub]) => pub.tabId === tabId);
    
    publishers.forEach(([id, _]) => {
        activePublishers.delete(id);
    });
    
    if (activeTabs.has(tabId)) {
        // Politely stop offscreen publisher; it will send bye and cleanup
        try {
            chrome.runtime.sendMessage({ type: 'stopTabCapture' });
        } catch (e) {}
        activeTabs.delete(tabId);
    }
});
