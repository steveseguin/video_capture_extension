// Offscreen document for tab capture
let mediaStream = null;
let vdoPublisher = null;

console.log('Offscreen document loaded');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Offscreen received message:', request);
    
    if (request.type === 'startTabCapture') {
        const { mediaStreamId, audio, video, streamId, roomId, server, settings } = request;
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
                await vdoPublisher.connect();
                console.log('Connected, SDK state:', {
                    ws: vdoPublisher.ws ? 'exists' : 'missing',
                    room: vdoPublisher.room,
                    streamID: vdoPublisher.streamID
                });
                
                // If room is specified, join it
                if (roomId && vdoPublisher.room) {
                    console.log('Joining room:', roomId);
                    await vdoPublisher.joinRoom();
                }
                
                // Prepare publish options - use settings from popup
                const publishOptions = {
                    streamID: streamId,
                    publish: true,
                    bitrate: settings?.bitrate || 6000,
                    codec: settings?.codec || 'h264'
                };
                
                // Publish the stream
                console.log('Publishing stream with options:', publishOptions);
                const publishResult = await vdoPublisher.publish(mediaStream, publishOptions);
                console.log('Publish result:', publishResult);
                console.log('Stream published, WebRTC state:', {
                    peerConnections: vdoPublisher.pcs ? Object.keys(vdoPublisher.pcs).length : 0,
                    streamID: vdoPublisher.streamID
                });
                
                console.log('Stream published successfully to VDO.Ninja');
                
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
        if (vdoPublisher) {
            try {
                vdoPublisher.disconnect();
                vdoPublisher = null;
            } catch (e) {
                console.error('Error disconnecting VDO publisher:', e);
            }
        }
        
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        
        sendResponse({ success: true });
        return false;
    }
    
    // Don't respond to messages not meant for offscreen document
    return false;
});