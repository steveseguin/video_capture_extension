const activePublishers = new Map();
const activeTabs = new Map();

function generateStreamId() {
    return 'stream_' + Math.random().toString(36).substr(2, 9);
}

function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
}

function getVdoLinks(server, roomId, streamId, qualitySettings = {}) {
    // Ensure server has proper format
    if (!server.includes('://')) {
        server = 'https://' + server;
    }
    const baseUrl = server.replace(/\/$/, ''); // Remove trailing slash
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

async function injectSDK(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['inject.js']
        });
        return true;
    } catch (error) {
        console.error('Failed to inject SDK:', error);
        return false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender).then(sendResponse);
    return true;
});

async function handleMessage(request, sender) {
    switch(request.type) {
        case 'startStream':
            return await startVideoStream(request);
            
        case 'stopStream':
            return await stopVideoStream(request);
            
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

function checkExistingStream(request) {
    const { videoId } = request;
    const publisher = activePublishers.get(videoId);
    
    if (publisher) {
        return {
            exists: true,
            streamId: publisher.streamId,
            roomId: publisher.roomId,
            links: getVdoLinks(publisher.server, publisher.roomId, publisher.streamId)
        };
    }
    
    return { exists: false };
}

async function startVideoStream(request) {
    const { videoId, tabId, settings, title } = request;
    
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
            target: { tabId: tabId },
            func: () => window.vdoFullyLoaded
        });
        
        if (!checkResult.result) {
            // Inject the SDK loader
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['sdk-loader.js']
            });
            
            // Wait for everything to load
            let loaded = false;
            for (let i = 0; i < 20; i++) {
                await new Promise(resolve => setTimeout(resolve, 250));
                const [loadCheck] = await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: () => window.vdoFullyLoaded
                });
                if (loadCheck.result) {
                    loaded = true;
                    console.log('VDO fully loaded after', (i + 1) * 250, 'ms');
                    break;
                }
            }
            
            if (!loaded) {
                console.warn('VDO not fully loaded after 5 seconds, proceeding anyway');
            }
        }
        
        const streamId = settings.streamId || generateStreamId();
        const roomId = settings.roomId || '';
        const server = settings.server || 'vdo.ninja';
        
        // Use event-based communication to call publisher functions
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: async (videoId, streamId, roomId, title) => {
                console.log('Sending publish request via events...');
                
                return new Promise((resolve) => {
                    // Set up response listener
                    const responseHandler = (event) => {
                        console.log('Received publish response:', event.detail);
                        window.removeEventListener('vdo-publish-response', responseHandler);
                        resolve(event.detail);
                    };
                    window.addEventListener('vdo-publish-response', responseHandler);
                    
                    // Send publish request
                    window.dispatchEvent(new CustomEvent('vdo-publish-request', {
                        detail: { videoId, streamId, roomId, title }
                    }));
                    
                    // Timeout after 10 seconds
                    setTimeout(() => {
                        window.removeEventListener('vdo-publish-response', responseHandler);
                        resolve({ success: false, error: 'Publish request timed out after 10 seconds' });
                    }, 10000);
                });
            },
            args: [videoId, streamId, roomId, title]
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
            title: title,
            qualitySettings: settings
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
        // Stop publisher using event-based communication
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: async (streamId) => {
                return new Promise((resolve) => {
                    const responseHandler = (event) => {
                        window.removeEventListener('vdo-stop-response', responseHandler);
                        resolve(event.detail);
                    };
                    window.addEventListener('vdo-stop-response', responseHandler);
                    
                    window.dispatchEvent(new CustomEvent('vdo-stop-request', {
                        detail: { streamId }
                    }));
                    
                    setTimeout(() => {
                        window.removeEventListener('vdo-stop-response', responseHandler);
                        resolve({ success: false, error: 'Stop request timed out' });
                    }, 5000);
                });
            },
            args: [publisher.streamId]
        });
        
        // Stop capture
        await chrome.tabs.sendMessage(tabId, {
            type: 'stopCapture',
            videoId: videoId
        });
        
        activePublishers.delete(videoId);
        
        return { success: true };
    } catch (error) {
        console.error('Error stopping stream:', error);
        return { success: false, error: error.message };
    }
}

async function startTabCapture(request) {
    const { tabId, audio, video, settings } = request;
    
    try {
        const streamId = settings.streamId || generateStreamId();
        const roomId = settings.roomId || null;
        const server = settings.server || 'vdo.ninja';
        
        const stream = await chrome.tabCapture.capture({
            audio: audio,
            video: video,
            videoConstraints: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    maxWidth: 1920,
                    maxHeight: 1080
                }
            }
        });
        
        if (!stream) {
            return { success: false, error: 'Failed to capture tab' };
        }
        
        const injected = await injectSDK(tabId);
        if (!injected) {
            stream.getTracks().forEach(track => track.stop());
            return { success: false, error: 'Failed to inject SDK' };
        }
        
        const publishResult = await chrome.tabs.sendMessage(tabId, {
            type: 'publishTabStream',
            streamId: streamId,
            roomId: roomId,
            server: server
        });
        
        if (publishResult && publishResult.success) {
            activeTabs.set(tabId, {
                stream: stream,
                streamId: streamId,
                roomId: roomId,
                server: server
            });
            
            return {
                success: true,
                streamId: streamId,
                roomId: roomId,
                links: getVdoLinks(server, roomId, streamId)
            };
        }
        
        stream.getTracks().forEach(track => track.stop());
        return { success: false, error: 'Failed to publish tab stream' };
        
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
            links: getVdoLinks(publisher.server, publisher.roomId, publisher.streamId)
        });
    });
    
    activeTabs.forEach((tab, tabId) => {
        streams.push({
            id: `tab-${tabId}`,
            type: 'tab',
            tabId: tabId,
            ...tab,
            links: getVdoLinks(tab.server, tab.roomId, tab.streamId)
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
        const capture = activeTabs.get(tabId);
        if (capture.stream) {
            capture.stream.getTracks().forEach(track => track.stop());
        }
        activeTabs.delete(tabId);
    }
});