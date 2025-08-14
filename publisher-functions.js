// Publisher functions that run in page context
console.log('Setting up VDO publisher functions...');

// Wait for SDK
let attempts = 0;
const checkSDK = setInterval(() => {
    attempts++;
    
    if (typeof VDONinja !== 'undefined' || typeof VDONinjaSDK !== 'undefined') {
        clearInterval(checkSDK);
        console.log('SDK constructors available:', {
            VDONinja: typeof VDONinja,
            VDONinjaSDK: typeof VDONinjaSDK
        });
        setupPublisherFunctions();
    } else if (attempts > 30) {
        clearInterval(checkSDK);
        console.error('SDK not available after 3 seconds');
    }
}, 100);

function setupPublisherFunctions() {
    // Create the publisher function
    window.publishVideoToVDO = async function(videoId, streamId, roomId, title) {
        try {
            console.log('Publishing:', { videoId, streamId, roomId, title });
            
            const video = document.querySelector(`[data-vdo-capture-id="${videoId}"]`);
            if (!video) {
                throw new Error('Video element not found');
            }
            
            // Capture stream
            let stream;
            if (video.captureStream) {
                stream = video.captureStream(30);
            } else if (video.mozCaptureStream) {
                stream = video.mozCaptureStream(30);
            } else if (video.srcObject instanceof MediaStream) {
                stream = video.srcObject;
            } else {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 640;
                canvas.height = video.videoHeight || 480;
                const ctx = canvas.getContext('2d');
                
                function draw() {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    requestAnimationFrame(draw);
                }
                draw();
                
                stream = canvas.captureStream(30);
            }
            
            // Create SDK instance
            let vdo;
            if (typeof VDONinja !== 'undefined') {
                vdo = new VDONinja({salt: "vdo.ninja"});
                console.log('Using VDONinja');
            } else if (typeof VDONinjaSDK !== 'undefined') {
                vdo = new VDONinjaSDK({salt: "vdo.ninja"});
                console.log('Using VDONinjaSDK');
            } else {
                throw new Error('No SDK constructor');
            }
            
            // Connect to websocket first
            console.log('Connecting to VDO.Ninja...');
            await vdo.connect();
            
            // Prepare publish options
            const publishOptions = {
                streamID: streamId
            };
            
            if (roomId && roomId.trim()) {
                publishOptions.room = roomId;
            }
            
            // Publish the stream with options
            console.log('Publishing with options:', publishOptions);
            await vdo.publish(stream, publishOptions);
            
            // Store
            window.vdoPublishers = window.vdoPublishers || {};
            window.vdoPublishers[streamId] = { vdo, stream };
            
            console.log('Published successfully');
            return { success: true, streamId };
            
        } catch (error) {
            console.error('Publish error:', error);
            return { success: false, error: error.message };
        }
    };
    
    // Stop function
    window.stopVDOPublisher = async function(streamId) {
        try {
            if (window.vdoPublishers && window.vdoPublishers[streamId]) {
                const { vdo, stream } = window.vdoPublishers[streamId];
                
                if (vdo && vdo.disconnect) {
                    await vdo.disconnect();
                }
                
                if (stream) {
                    stream.getTracks().forEach(track => track.stop());
                }
                
                delete window.vdoPublishers[streamId];
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    };
    
    window.vdoPublisherReady = true;
    console.log('VDO publisher functions ready!');
}