// Offscreen document for tab capture
let mediaStream = null;
let vdoPublisher = null;
let sourceTabId = null;
let captureStarting = false;
let captureGeneration = 0;
let removeCaptureListeners = () => {};

function cleanupCapture() {
    captureGeneration++;
    captureStarting = false;
    removeCaptureListeners();
    removeCaptureListeners = () => {};
    const publisher = vdoPublisher;
    const stream = mediaStream;
    vdoPublisher = null;
    mediaStream = null;
    sourceTabId = null;
    try { publisher?.sendData?.({ bye: true }, { allowFallback: false }); } catch (e) {}
    try { publisher?.disconnect(); } catch (e) {}
    stream?.getTracks().forEach(track => track.stop());
}

function sendCaptureBye() {
    try { vdoPublisher?.sendData?.({ bye: true }, { allowFallback: false }); } catch (e) {}
}
window.addEventListener('pagehide', sendCaptureBye);
window.addEventListener('beforeunload', sendCaptureBye);

// offscreen document loaded

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // received message in offscreen doc
    
    if (request.type === 'startTabCapture') {
        if (captureStarting || mediaStream) {
            sendResponse({ success: false, error: 'Stop the current tab capture before starting another' });
            return false;
        }
        captureStarting = true;
        const generation = ++captureGeneration;
        const { mediaStreamId, audio, video, streamId, roomId, server, settings, tabId, title } = request;
        sourceTabId = tabId || null;
        
        
        // Get the media stream using the stream ID
        navigator.mediaDevices.getUserMedia({
            audio: audio ? {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: mediaStreamId
                }
            } : false,
            video: video ? {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: mediaStreamId
                }
            } : false
        }).then(async (stream) => {
            if (generation !== captureGeneration) {
                stream.getTracks().forEach(track => track.stop());
                throw new Error('Tab capture was stopped during startup');
            }
            mediaStream = stream;
            const checkCurrent = () => {
                if (generation !== captureGeneration || stream.getTracks().some(track => track.readyState === 'ended')) {
                    throw new Error('Tab capture ended during startup');
                }
            };
            const handleEnd = () => {
                if (generation !== captureGeneration) return;
                const endedTabId = sourceTabId;
                cleanupCapture();
                if (endedTabId != null) chrome.runtime.sendMessage({ type: 'tabCaptureEnded', tabId: endedTabId }).catch(() => {});
            };
            stream.getTracks().forEach(track => track.addEventListener('ended', handleEnd, { once: true }));
            removeCaptureListeners = () => stream.getTracks().forEach(track => track.removeEventListener?.('ended', handleEnd));
            try {
                checkCurrent();
                // Initialize VDO.Ninja SDK with room configuration
                const sdkConfig = {
                    salt: "vdo.ninja",
                    room: roomId || null,
                    streamID: streamId,
                    debug: true
                };
                
                if (typeof VDONinja !== 'undefined') {
                    vdoPublisher = new VDONinja(sdkConfig);
                    
                } else if (typeof VDONinjaSDK !== 'undefined') {
                    vdoPublisher = new VDONinjaSDK(sdkConfig);
                    
                } else {
                    throw new Error('No SDK constructor available');
                }
                const publisher = vdoPublisher;
                
                // Listen for connection events
                vdoPublisher.addEventListener('socket-connected', (e) => {});
                
                vdoPublisher.addEventListener('socket-disconnected', (e) => {});
                
                // Connect to websocket
                
                // Map selected server to a WebSocket host, if applicable
                const serverStr = (server || settings?.server || '').toString();
                let hostOverride = null;
                if (serverStr.includes('apibackup.vdo.ninja')) {
                    hostOverride = 'wss://apibackup.vdo.ninja';
                } else if (serverStr.startsWith('wss://')) {
                    hostOverride = serverStr;
                } else if (serverStr.includes('vdo.ninja')) {
                    hostOverride = 'wss://wss.vdo.ninja';
                }
                // Connect with password if provided (empty uses default)
                const connectOpts = { password: (settings?.password !== undefined ? settings.password : undefined) };
                if (hostOverride) connectOpts.host = hostOverride;
                await publisher.connect(connectOpts);
                checkCurrent();
                
                
                // If room is specified, join it
                if (roomId && publisher.room) {
                    
                    await publisher.joinRoom({ room: roomId, password: (settings?.password !== undefined ? settings.password : undefined) });
                    checkCurrent();
                }
                
                // Prepare publish options - use settings from popup
                const publishOptions = {
                    streamID: streamId,
                    publish: true,
                    videoBitrate: `${settings?.bitrate || 6000}kbps`,
                    videoCodec: settings?.codec || undefined,
                    info: { label: title || 'Tab Capture' }
                };
                if (settings?.password !== undefined) publishOptions.password = settings.password;
                
                // Publish the stream
                
                await publisher.publish(stream, publishOptions);
                checkCurrent();
                
                
                

                // (Label metadata broadcast intentionally omitted; handled externally)

                
                captureStarting = false;
                sendResponse({ 
                    success: true, 
                    streamActive: true,
                    audioTracks: mediaStream.getAudioTracks().length,
                    videoTracks: mediaStream.getVideoTracks().length,
                    streamId: streamId,
                    roomId: roomId
                });
            } catch (error) {
                console.error('Failed to publish to VDO.Ninja:', error);
                if (generation === captureGeneration) cleanupCapture();
                sendResponse({ 
                    success: false,
                    streamActive: false,
                    error: 'Publishing failed: ' + error.message
                });
            }
        }).catch(error => {
            if (generation === captureGeneration) cleanupCapture();
            console.error('Tab capture error in offscreen:', error);
            sendResponse({ success: false, error: error.message });
        });
        
        return true; // Will respond asynchronously
        
    } else if (request.type === 'stopTabCapture') {
        if (request.target !== 'offscreen') return false;
        if (sourceTabId != null && request.tabId !== sourceTabId) {
            sendResponse({ success: false, error: 'Tab capture belongs to another tab' });
            return false;
        }
        cleanupCapture();
        sendResponse({ success: true });
        return false;
    } else if (request.type === 'getTabThumbnail') {
        // Return a small thumbnail from the active mediaStream if available
        if (!mediaStream || !mediaStream.getVideoTracks().length) {
            sendResponse({ success: false, error: 'No active tab capture' });
            return false;
        }
        try {
            const video = document.createElement('video');
            video.muted = true;
            video.srcObject = mediaStream;
            const width = 160; const height = 90;
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');

            let finished = false;
            let scheduled = false;
            const finish = response => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                video.pause();
                video.srcObject = null;
                sendResponse(response);
            };
            const timeout = setTimeout(() => finish({ success: false, error: 'Thumbnail request timed out' }), 2000);

            const draw = () => {
                if (finished) return;
                try {
                    ctx.drawImage(video, 0, 0, width, height);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                    finish({ success: true, dataUrl });
                } catch (e) {
                    finish({ success: false, error: e.message });
                }
            };

            const onReady = () => {
                if (finished || scheduled) return;
                scheduled = true;
                if (video.requestVideoFrameCallback) {
                    video.requestVideoFrameCallback(() => draw());
                } else {
                    setTimeout(draw, 30);
                }
            };

            video.addEventListener('loadeddata', onReady, { once: true });
            video.addEventListener('playing', onReady, { once: true });
            video.play().catch(error => finish({ success: false, error: error.message }));
            return true; // async response
        } catch (e) {
            sendResponse({ success: false, error: e.message });
            return false;
        }
    }
    
    // Don't respond to messages not meant for offscreen document
    return false;
});
