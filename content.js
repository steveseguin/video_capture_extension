let capturedStreams = new Map();
let videoObserver = null;

function detectVideos() {
    const videos = document.querySelectorAll('video');
    const videoData = [];
    
    videos.forEach((video, index) => {
        if (video.srcObject || video.src) {
            const videoId = `video-${index}-${Date.now()}`;
            const rect = video.getBoundingClientRect();
            
            const data = {
                id: videoId,
                index: index,
                visible: rect.width > 0 && rect.height > 0,
                width: video.videoWidth || rect.width,
                height: video.videoHeight || rect.height,
                src: video.src || 'MediaStream',
                hasAudio: hasAudioTrack(video),
                paused: video.paused,
                muted: video.muted,
                duration: video.duration,
                currentTime: video.currentTime,
                poster: video.poster || null,
                title: getVideoTitle(video)
            };
            
            video.dataset.vdoCaptureId = videoId;
            videoData.push(data);
        }
    });
    
    return videoData;
}

function hasAudioTrack(video) {
    if (video.srcObject && video.srcObject.getAudioTracks) {
        return video.srcObject.getAudioTracks().length > 0;
    }
    return !video.muted && video.volume > 0;
}

function getVideoTitle(video) {
    const parent = video.closest('[aria-label], [title]');
    if (parent) {
        return parent.getAttribute('aria-label') || parent.getAttribute('title');
    }
    
    const alt = video.getAttribute('alt') || video.getAttribute('title');
    if (alt) return alt;
    
    if (window.location.hostname.includes('youtube')) {
        const titleEl = document.querySelector('h1.ytd-video-primary-info-renderer, .ytp-title-link');
        if (titleEl) return titleEl.textContent;
    } else if (window.location.hostname.includes('discord')) {
        const usernameEl = video.closest('[class*="videoWrapper"]')?.querySelector('[class*="username"]');
        if (usernameEl) return usernameEl.textContent;
    }
    
    return `Video ${video.dataset.vdoCaptureId}`;
}

async function captureVideo(videoId) {
    const video = document.querySelector(`[data-vdo-capture-id="${videoId}"]`);
    if (!video) return null;
    
    try {
        let stream;
        
        if (video.captureStream) {
            stream = video.captureStream();
        } else if (video.mozCaptureStream) {
            stream = video.mozCaptureStream();
        } else if (video.srcObject) {
            stream = video.srcObject;
        } else {
            throw new Error('Cannot capture stream from this video');
        }
        
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        
        if (videoTracks.length === 0) {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            const ctx = canvas.getContext('2d');
            
            const canvasStream = canvas.captureStream(30);
            
            const drawFrame = () => {
                if (!capturedStreams.has(videoId)) return;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                requestAnimationFrame(drawFrame);
            };
            drawFrame();
            
            stream = new MediaStream([
                ...canvasStream.getVideoTracks(),
                ...audioTracks
            ]);
        }
        
        capturedStreams.set(videoId, {
            stream: stream,
            video: video,
            title: getVideoTitle(video)
        });
        
        return {
            id: videoId,
            title: getVideoTitle(video),
            hasAudio: audioTracks.length > 0,
            hasVideo: videoTracks.length > 0
        };
        
    } catch (error) {
        console.error('Error capturing video:', error);
        return null;
    }
}

async function captureScreenshot(videoId) {
    const video = document.querySelector(`[data-vdo-capture-id="${videoId}"]`);
    if (!video) return null;
    
    try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 180;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        return canvas.toDataURL('image/jpeg', 0.8);
    } catch (error) {
        console.error('Error capturing screenshot:', error);
        return null;
    }
}

function stopCapture(videoId) {
    const capture = capturedStreams.get(videoId);
    if (capture && capture.stream) {
        capture.stream.getTracks().forEach(track => track.stop());
        capturedStreams.delete(videoId);
        return true;
    }
    return false;
}

function setupVideoObserver() {
    if (videoObserver) return;
    
    videoObserver = new MutationObserver((mutations) => {
        let videoAdded = false;
        
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
                    videoAdded = true;
                    break;
                }
            }
            if (videoAdded) break;
        }
        
        if (videoAdded) {
            setTimeout(() => {
                chrome.runtime.sendMessage({
                    type: 'videosUpdated',
                    videos: detectVideos()
                });
            }, 500);
        }
    });
    
    videoObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        switch(request.type) {
            case 'detectVideos':
                sendResponse(detectVideos());
                break;
            
        case 'captureVideo':
            captureVideo(request.videoId).then(result => {
                sendResponse(result);
            });
            return true;
            
        case 'captureScreenshot':
            captureScreenshot(request.videoId).then(screenshot => {
                sendResponse(screenshot);
            });
            return true;
            
        case 'stopCapture':
            sendResponse(stopCapture(request.videoId));
            break;
            
        case 'getStream':
            const capture = capturedStreams.get(request.videoId);
            if (capture && capture.stream) {
                sendResponse({
                    success: true,
                    id: request.videoId,
                    title: capture.title
                });
            } else {
                sendResponse({ success: false });
            }
            break;
            
        case 'startObserving':
            setupVideoObserver();
            sendResponse({ success: true });
            break;
            
        default:
            sendResponse({ error: 'Unknown request type' });
        }
    } catch (error) {
        console.error('Content script error:', error);
        sendResponse({ error: error.message });
    }
    return true;
});

document.addEventListener('DOMContentLoaded', setupVideoObserver);
if (document.readyState !== 'loading') {
    setupVideoObserver();
}