// Offscreen document for tab capture
let mediaStream = null;
let vdoPublisher = null;
let sourceTabId = null;

console.log('Offscreen document loaded');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Offscreen received message:', request);
    
    if (request.type === 'startTabCapture') {
        const { mediaStreamId, audio, video, streamId, roomId, server, settings, tabId, title } = request;
        sourceTabId = tabId || null;
        console.log('Starting tab capture with stream ID:', mediaStreamId);
        
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
            mediaStream = stream;
            console.log('Got media stream, publishing to VDO.Ninja...');
            
            try {
                // Initialize VDO.Ninja SDK with room configuration
                const sdkConfig = {
                    salt: "vdo.ninja",
                    room: roomId || null,
                    streamID: streamId,
                    debug: true
                };
                
                if (typeof VDONinja !== 'undefined') {
                    vdoPublisher = new VDONinja(sdkConfig);
                    console.log('Using VDONinja');
                } else if (typeof VDONinjaSDK !== 'undefined') {
                    vdoPublisher = new VDONinjaSDK(sdkConfig);
                    console.log('Using VDONinjaSDK');
                } else {
                    throw new Error('No SDK constructor available');
                }
                
                // Listen for connection events
                vdoPublisher.addEventListener('socket-connected', (e) => {
                    console.log('WebSocket connected!', e);
                });
                
                vdoPublisher.addEventListener('socket-disconnected', (e) => {
                    console.log('WebSocket disconnected!', e);
                });
                
                // Connect to websocket
                console.log('Connecting to VDO.Ninja WebSocket with config:', sdkConfig);
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
                await vdoPublisher.connect(connectOpts);
                console.log('Connected, SDK state:', {
                    ws: vdoPublisher.ws ? 'exists' : 'missing',
                    room: vdoPublisher.room,
                    streamID: vdoPublisher.streamID
                });
                
                // If room is specified, join it
                if (roomId && vdoPublisher.room) {
                    console.log('Joining room:', roomId);
                    await vdoPublisher.joinRoom({ room: roomId, password: (settings?.password !== undefined ? settings.password : undefined) });
                }
                
                // Prepare publish options - use settings from popup
                const publishOptions = {
                    streamID: streamId,
                    publish: true,
                    bitrate: settings?.bitrate || 6000,
                    codec: settings?.codec || 'h264',
                    info: { label: title || 'Tab Capture' }
                };
                if (settings?.password !== undefined) publishOptions.password = settings.password;
                
                // Publish the stream
                console.log('Publishing stream with options:', publishOptions);
                const publishResult = await vdoPublisher.publish(mediaStream, publishOptions);
                console.log('Publish result:', publishResult);
                console.log('Stream published, WebRTC state:', {
                    peerConnections: vdoPublisher.pcs ? Object.keys(vdoPublisher.pcs).length : 0,
                    streamID: vdoPublisher.streamID
                });
                
                console.log('Stream published successfully to VDO.Ninja');

                // (Label metadata broadcast intentionally omitted; handled externally)

                // Hook track end to signal bye and cleanup
                try {
                    const sendBye = () => {
                        try { vdoPublisher && vdoPublisher.sendData && vdoPublisher.sendData({ bye: true }, { allowFallback: false }); } catch (e) {}
                    };
                    const handleEnd = async () => {
                        try { sendBye(); } catch (e) {}
                        await new Promise(r => setTimeout(r, 50));
                        try { vdoPublisher && vdoPublisher.disconnect && vdoPublisher.disconnect(); } catch (e) {}
                        try { mediaStream && mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
                        try { if (sourceTabId) chrome.runtime.sendMessage({ type: 'stopTabCapture', tabId: sourceTabId }); } catch (e) {}
                    };
                    mediaStream.getTracks().forEach(t => t.addEventListener('ended', handleEnd, { once: true }));
                    // Offscreen document unload
                    window.addEventListener('pagehide', sendBye);
                    window.addEventListener('beforeunload', sendBye);
                } catch (e) {}
                
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
                sendResponse({ 
                    success: true, // Stream captured but publishing failed
                    streamActive: true,
                    audioTracks: mediaStream.getAudioTracks().length,
                    videoTracks: mediaStream.getVideoTracks().length,
                    error: 'Publishing failed: ' + error.message
                });
            }
        }).catch(error => {
            console.error('Tab capture error in offscreen:', error);
            sendResponse({ success: false, error: error.message });
        });
        
        return true; // Will respond asynchronously
        
    } else if (request.type === 'stopTabCapture') {
        // Politely notify and cleanup
        try { vdoPublisher && vdoPublisher.sendData && vdoPublisher.sendData({ bye: true }, { allowFallback: false }); } catch (e) {}
        setTimeout(() => {
            try {
                if (vdoPublisher) {
                    vdoPublisher.disconnect();
                    vdoPublisher = null;
                }
            } catch (e) {
                console.error('Error disconnecting VDO publisher:', e);
            }
            try {
                if (mediaStream) {
                    mediaStream.getTracks().forEach(track => track.stop());
                    mediaStream = null;
                }
            } catch (e) {}
            sendResponse({ success: true });
        }, 50);
        return true; // respond asynchronously after delay
    } else if (request.type === 'getTabThumbnail') {
        // Return a small thumbnail from the active mediaStream if available
        if (!mediaStream) {
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

            const draw = () => {
                try {
                    ctx.drawImage(video, 0, 0, width, height);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                    sendResponse({ success: true, dataUrl });
                } catch (e) {
                    sendResponse({ success: false, error: e.message });
                }
            };

            const onReady = () => {
                if (video.requestVideoFrameCallback) {
                    video.requestVideoFrameCallback(() => draw());
                } else {
                    setTimeout(draw, 30);
                }
            };

            video.addEventListener('loadeddata', onReady, { once: true });
            video.addEventListener('playing', onReady, { once: true });
            video.play().catch(() => {});
            return true; // async response
        } catch (e) {
            sendResponse({ success: false, error: e.message });
            return false;
        }
    }
    
    // Don't respond to messages not meant for offscreen document
    return false;
});
