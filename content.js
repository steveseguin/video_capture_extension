// Lightweight content script - minimal impact until extension is used
let capturedStreams = new Map();
let videoObserver = null;
let isInitialized = false;

// Discord rebuilds call tiles when switching layouts. Keep source identities for
// this page's lifetime, independent of element order and generated CSS classes.
const discordSources = new Map();
const discordVideoIds = new WeakMap();

function isDiscordVideoPage() {
    return typeof window !== 'undefined' && window.location &&
        /(^|\.)discord(?:app)?\.com$/.test(window.location.hostname);
}

function discordVideoIdentity(video) {
    const media = [];
    if (video.srcObject instanceof MediaStream) {
        for (const track of video.srcObject.getVideoTracks()) {
            if (track.id) media.push('track:' + track.id);
        }
        if (video.srcObject.id) media.push('stream:' + video.srcObject.id);
    }
    // Discord puts the participant ID one level above the labelled overlay.
    // Bound all metadata searches to that tile, including while its label is absent.
    const sourceTile = video.closest('[data-selenium-video-tile]');
    let tile = sourceTile;
    let label = '';
    // Labels may be on a sibling overlay. Never walk into a different tile.
    for (let node = video; node && node !== document.body; node = node.parentElement) {
        if (node.querySelectorAll('video').length > 1) break;
        const labelled = [node, ...node.querySelectorAll('[aria-label]')].find(element =>
            /^Call tile,\s*\S/i.test(element.getAttribute('aria-label') || ''));
        if (labelled) {
            if (!tile) tile = node;
            label = labelled.getAttribute('aria-label').trim();
            break;
        }
        if (node === sourceTile) break;
    }
    let owner = '';
    if (tile) {
        owner = sourceTile ? sourceTile.getAttribute('data-selenium-video-tile') || '' : '';
        const user = tile.closest('[data-user-id]') || tile.querySelector('[data-user-id]');
        if (!owner && user) owner = user.getAttribute('data-user-id') || '';
        if (!owner) {
            for (const image of tile.querySelectorAll('img[src]')) {
                try {
                    const url = new URL(image.src);
                    const match = url.pathname.match(/^\/avatars\/(\d+)\//);
                    if (/(^|\.)discordapp\.(com|net)$/.test(url.hostname) && match) {
                        owner = match[1];
                        break;
                    }
                } catch (e) {}
            }
        }
    }
    // Keep a participant's camera separate from their shared screen.
    const role = label ? (/,\s*stream(?:,|$)/i.test(label) ? 'screen' : 'camera') : '';
    const scope = window.location.pathname;
    return { media, owner: owner && role ? scope + ':' + owner + ':' + role : '',
        userId: /^\d{17,20}$/.test(owner) ? owner : '',
        participant: owner ? scope + ':' + owner : '',
        tile: label ? scope + ':' + label : '', role, scope };
}

function discordIdentitiesConflict(left, right) {
    return left.scope !== right.scope || !!(left.role && right.role && left.role !== right.role) ||
        !!(left.participant && right.participant && left.participant !== right.participant) ||
        !!(left.owner && right.owner && left.owner !== right.owner);
}

function updateDiscordVideoIds(videos) {
    const items = Array.from(videos, video => {
        const rect = video.getBoundingClientRect();
        const live = video.srcObject instanceof MediaStream ?
            video.srcObject.getVideoTracks().some(track => track.readyState === 'live') : video.readyState >= 2;
        return { video, identity: discordVideoIdentity(video),
            priority: (live ? 2 : 0) + (rect.width > 0 && rect.height > 0 ? 1 : 0) };
    });
    const assigned = new Set();
    // Preserve known elements first so a newly inserted tile cannot steal an ID.
    // A changed label needs current owner/media evidence; a remembered owner
    // alone cannot identify a video node recycled for another participant.
    for (const item of items) {
        const id = discordVideoIds.get(item.video);
        const record = discordSources.get(id);
        if (record && record.identity.role && !item.identity.role && item.identity.media.length &&
            !record.identity.media.some(key => item.identity.media.includes(key))) {
            // The same element can switch between a camera and a screen share.
            item.waitForRole = true;
            continue;
        }
        if (record && (!record.video || record.video === item.video) && !assigned.has(record) &&
            !discordIdentitiesConflict(record.identity, item.identity) &&
            !(!record.identity.tile && !record.identity.owner && record.identity.media.length &&
              item.identity.media.length && !record.identity.media.some(key => item.identity.media.includes(key))) &&
            !(record.identity.tile && item.identity.tile && record.identity.tile !== item.identity.tile &&
              !(record.identity.owner && record.identity.owner === item.identity.owner) &&
              !record.identity.media.some(key => item.identity.media.includes(key)))) {
            item.record = record;
            assigned.add(record);
        }
    }
    for (const item of items) {
        if (item.record || item.waitForRole) continue;
        // Only reuse an unambiguous source. Track labels and tile positions are
        // not identities; two people can have the same camera or display name.
        for (const kind of ['media', 'owner', 'tile']) {
            const keys = kind === 'media' ? item.identity.media : [item.identity[kind]].filter(Boolean);
            const matches = new Set();
            for (const key of keys) {
                const hasKey = identity => kind === 'media' ? identity.media.includes(key) : identity[kind] === key;
                // Fullscreen transitions can briefly show two elements for the
                // same receive track or participant. Only names must be unique.
                if (kind === 'tile' && items.filter(other => hasKey(other.identity)).length !== 1) continue;
                const records = [...discordSources.values()].filter(record =>
                    hasKey(record.identity) && !discordIdentitiesConflict(record.identity, item.identity));
                if (records.length === 1 && (kind !== 'tile' || !assigned.has(records[0]))) matches.add(records[0]);
            }
            if (matches.size === 1) {
                item.record = [...matches][0];
                assigned.add(item.record);
                break;
            }
            if (matches.size > 1) break;
        }
        if (!item.record) {
            // A rebuilt tile may receive its label after its video. Wait for
            // camera/screen identity instead of allocating a replacement ID.
            if (item.identity.participant && !item.identity.role &&
                [...discordSources.values()].some(record => record.identity.participant === item.identity.participant)) continue;
            const id = 'video-' + crypto.randomUUID();
            item.record = { id, identity: item.identity, video: item.video };
            discordSources.set(id, item.record);
            assigned.add(item.record);
        }
    }
    const selected = new Map();
    for (const item of items) {
        const { video, record } = item;
        if (!record) continue;
        const previous = selected.get(record);
        // Fullscreen and grid copies can overlap. Prefer live, visible media
        // instead of letting a hidden or ended copy win by DOM order.
        if (!previous || item.priority >= previous.priority) selected.set(record, item);
        discordVideoIds.set(video, record.id);
        if (video.dataset.vdoCaptureId !== record.id) video.dataset.vdoCaptureId = record.id;
    }
    for (const { video, identity, record } of selected.values()) {
        // Rendering transitions may temporarily omit the tile overlay/avatar.
        if (!identity.participant) identity.participant = record.identity.participant;
        if (!identity.owner) identity.owner = record.identity.owner;
        if (!identity.tile) identity.tile = record.identity.tile;
        if (!identity.role) identity.role = record.identity.role;
        record.identity = identity;
        record.video = video;
    }
    for (const record of discordSources.values()) {
        if (!assigned.has(record)) record.video = null;
    }
    // Bound retained detached tiles while keeping every active publisher.
    if (discordSources.size > 256) {
        const active = new Set(Object.values(window.vdoPublishers || {}).map(record => record.videoId));
        for (const [id, record] of discordSources) {
            if (!assigned.has(record) && !active.has(id)) discordSources.delete(id);
            if (discordSources.size <= 256) break;
        }
    }
}

function findDiscordVideo(videoId) {
    updateDiscordVideoIds(document.querySelectorAll('video'));
    const record = discordSources.get(videoId);
    if (!record || !record.video || !record.video.isConnected || record.video.dataset.vdoCaptureId !== videoId) return null;
    return record.video;
}

function getDiscordPersistentSourceKey(videoId) {
    if (!isDiscordVideoPage()) return '';
    const video = findDiscordVideo(videoId);
    if (!video) return '';
    // Use current metadata, not a retained label from an earlier tile occupant.
    const identity = discordVideoIdentity(video);
    if (!identity.userId || !identity.role) return '';
    return 'discordStream:' + identity.userId + ':' + identity.role;
}

// These call pages expose source IDs independent of their current tile layout.
// Do not use display names or the shared "remote video" track label as identity.
const callVideoSources = new Map();

function callVideoSourceKey(video) {
    const host = window.location.hostname;
    if (/(^|\.)vdo\.ninja$/.test(host)) {
        const sid = video.getAttribute('data-sid');
        return sid ? 'vdo:' + sid : '';
    }
    if (host === 'meet.google.com') {
        const tile = video.closest('[data-participant-id][data-tile-media-id]');
        if (!tile) return '';
        const participant = tile.getAttribute('data-participant-id');
        const media = tile.getAttribute('data-tile-media-id');
        // Meet gives the presentation and camera separate media identities.
        return participant && media ? JSON.stringify(['meet', window.location.pathname, participant, media]) : '';
    }
    if (!/^(teams\.live\.com|teams\.microsoft\.com|teams\.cloud\.microsoft)$/.test(host)) return '';
    const tile = video.closest('[data-cid="calling-participant-stream"][data-stream-type]');
    const stream = video.srcObject;
    if (!tile || !(stream instanceof MediaStream)) return '';
    const track = stream.getVideoTracks()[0];
    if (!track || !track.id || !stream.id) return '';
    // Include both media IDs and the role: a camera and a share are separate
    // sources, even when they belong to the same participant.
    return JSON.stringify(['teams', tile.getAttribute('data-stream-type'), stream.id, track.id]);
}

function updateCallVideoIds(videos) {
    for (const record of callVideoSources.values()) record.video = null;
    for (const video of videos) {
        const key = callVideoSourceKey(video);
        if (!key) continue;
        let record = callVideoSources.get(key);
        if (!record) {
            record = { id: 'video-' + crypto.randomUUID(), video: null };
            callVideoSources.set(key, record);
        }
        video.dataset.vdoCaptureId = record.id;
        // A layout transition can briefly contain two copies of one source.
        const rect = video.getBoundingClientRect();
        const live = video.srcObject instanceof MediaStream &&
            video.srcObject.getVideoTracks().some(track => track.readyState === 'live');
        const priority = (live ? 2 : 0) + (rect.width > 0 && rect.height > 0 ? 1 : 0);
        if (!record.video || priority > record.priority) {
            record.video = video;
            record.priority = priority;
        }
    }
    if (callVideoSources.size > 256) {
        const active = new Set(Object.values(window.vdoPublishers || {}).map(record => record.videoId));
        for (const [key, record] of callVideoSources) {
            if (!record.video && !active.has(record.id)) callVideoSources.delete(key);
            if (callVideoSources.size <= 256) break;
        }
    }
}

function findCallVideo(videoId) {
    if (isDiscordVideoPage()) return findDiscordVideo(videoId);
    updateCallVideoIds(document.querySelectorAll('video'));
    for (const record of callVideoSources.values()) {
        if (record.id === videoId) return record.video;
    }
    return null;
}

// Only initialize when extension is actually used
function initialize() {
    if (isInitialized) return;
    isInitialized = true;
    setupVideoObserver();
}

function detectVideos() {
    const videos = document.querySelectorAll('video');
    const discord = isDiscordVideoPage();
    if (discord) updateDiscordVideoIds(videos);
    else updateCallVideoIds(videos);
    const videoData = [];
    
    videos.forEach((video, index) => {
        if (discord && discordSources.get(video.dataset.vdoCaptureId)?.video !== video) return;
        const callKey = !discord && callVideoSourceKey(video);
        if (callKey && callVideoSources.get(callKey)?.video !== video) return;
        const rect = video.getBoundingClientRect();
        const hasSrc = !!(video.currentSrc || video.src || video.srcObject);
        const isRenderable = video.readyState >= 2 || hasSrc || (rect.width > 0 && rect.height > 0);
        if (!isRenderable) return;

        const existingId = video.dataset.vdoCaptureId;
        const videoId = existingId || `video-${Array.from(crypto.getRandomValues(new Uint32Array(4)), part => part.toString(16).padStart(8, '0')).join('')}`;

        // Determine dimensions using intrinsic size first, then layout box
        const width = video.videoWidth || rect.width || 0;
        const height = video.videoHeight || rect.height || 0;
        const hasAudio = hasAudioTrack(video);

        // Filter out truly empty media: 0x0 with no audio
        if (width === 0 && height === 0 && !hasAudio) {
            return;
        }

        const data = {
            id: videoId,
            index: index,
            visible: rect.width > 0 && rect.height > 0,
            width: width,
            height: height,
            src: video.currentSrc || video.src || (video.srcObject ? 'MediaStream' : ''),
            hasAudio: hasAudio,
            paused: video.paused,
            muted: video.muted,
            duration: video.duration,
            currentTime: video.currentTime,
            poster: video.poster || null,
            title: getVideoTitle(video)
        };

        if (!existingId) {
            video.dataset.vdoCaptureId = videoId;
        }
        videoData.push(data);
    });
    
    return videoData;
}

function hasAudioTrack(video) {
    try {
        if (video.srcObject instanceof MediaStream) {
            return video.srcObject.getAudioTracks().length > 0;
        }
        if (typeof video.mozHasAudio === 'boolean') {
            return video.mozHasAudio;
        }
        if (typeof video.webkitAudioDecodedByteCount === 'number') {
            return video.webkitAudioDecodedByteCount > 0;
        }
        if (video.audioTracks && typeof video.audioTracks.length === 'number') {
            return video.audioTracks.length > 0;
        }
    } catch (e) {}
    // If we can't positively detect audio, be conservative and say no
    return false;
}

function findAriaLabelInSiblings(videoElement) {
  if (!videoElement) {
    return null;
  }

  // Start with the video element itself.
  let currentElement = videoElement;

  // Keep moving up the tree until there are no parents left.
  while (currentElement.parentElement) {
    // Check all siblings of the current element.
    for (const sibling of currentElement.parentElement.children) {
      // Skip the element we're currently on.
      if (sibling === currentElement) {
        continue;
      }
      // If a sibling has the aria-label, we're done.
      if (sibling.hasAttribute('aria-label')) {
        return sibling;
      }
    }
    // If no sibling had the label, move up to the parent and repeat the process.
    currentElement = currentElement.parentElement;
  }
  // Reached the top of the DOM without finding a match.
  return null;
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
	
	const parenttitle = video.closest('#title');
    if (parenttitle && parenttitle.textContent && parenttitle.textContent.length<26) {
		return parenttitle.textContent;
	}
	
	const AriaLabel = findAriaLabelInSiblings(video);
    if (AriaLabel) {
        return AriaLabel.getAttribute("aria-label").replace("Call tile, ","")
    }
    
    return document?.title.split(" - ")[0] || window.location.hostname || "";
}

async function captureVideo(videoId) {
    const video = isDiscordVideoPage() ? findDiscordVideo(videoId) : document.querySelector(`[data-vdo-capture-id="${videoId}"]`);
    if (!video) return null;
    const existing = capturedStreams.get(videoId);
    if (existing) {
        return { id: videoId, title: existing.title,
            hasAudio: existing.stream.getAudioTracks().length > 0,
            hasVideo: existing.stream.getVideoTracks().length > 0 };
    }
    let stream = null;
    let drawFrame = null;
    
    try {
        // Guard: avoid capturing empty 0x0 video with no audio
        const rect = video.getBoundingClientRect();
        const intrinsicW = video.videoWidth || 0;
        const intrinsicH = video.videoHeight || 0;
        const layoutW = rect.width || 0;
        const layoutH = rect.height || 0;
        const effW = intrinsicW || layoutW || 0;
        const effH = intrinsicH || layoutH || 0;
        const hasAudio = hasAudioTrack(video);
        if (effW === 0 && effH === 0 && !hasAudio) {
            throw new Error('Refusing to capture 0x0 video without audio');
        }

        if (video.captureStream) {
            stream = video.captureStream();
        } else if (video.mozCaptureStream) {
            stream = video.mozCaptureStream();
        } else if (video.srcObject) {
            stream = video.srcObject.clone();
        } else {
            throw new Error('Cannot capture stream from this video');
        }
        
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        
        if (videoTracks.length === 0) {
            const canvas = document.createElement('canvas');
            // If intrinsic size is 0, fall back to layout size; otherwise a small default
            const cw = video.videoWidth || rect.width || 640;
            const ch = video.videoHeight || rect.height || 480;
            canvas.width = cw;
            canvas.height = ch;
            const ctx = canvas.getContext('2d');
            
            const canvasStream = canvas.captureStream(30);
            
            drawFrame = () => {
                const capture = capturedStreams.get(videoId);
                if (!capture || capture.stream !== stream) return;
                try {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    capture.frameId = requestAnimationFrame(drawFrame);
                } catch (error) {
                    console.error('Canvas capture failed:', error);
                    stopCapture(videoId);
                }
            };
            
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
        if (drawFrame) drawFrame();
        if (!capturedStreams.has(videoId)) return null;
        
        return {
            id: videoId,
            title: getVideoTitle(video),
            hasAudio: audioTracks.length > 0,
            hasVideo: stream.getVideoTracks().length > 0
        };
        
    } catch (error) {
        if (capturedStreams.has(videoId)) stopCapture(videoId);
        else stream?.getTracks().forEach(track => track.stop());
        console.error('Error capturing video:', error);
        return null;
    }
}

async function captureScreenshot(videoId) {
    const video = isDiscordVideoPage() ? findDiscordVideo(videoId) : document.querySelector(`[data-vdo-capture-id="${videoId}"]`);
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
        if (capture.frameId != null) cancelAnimationFrame(capture.frameId);
        capture.stream.getTracks().forEach(track => track.stop());
        capturedStreams.delete(videoId);
        return true;
    }
    return false;
}

async function handleTabCaptureWithStreamId(request) {
    const { mediaStreamId, streamId, roomId, server, audio, video } = request;
    
    try {
        // Get the media stream using the stream ID from background script
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: audio ? {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: mediaStreamId
                }
            } : false,
            video: video ? {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: mediaStreamId,
                    maxWidth: 1920,
                    maxHeight: 1080
                }
            } : false
        });
        
        if (!stream) {
            throw new Error('Failed to capture tab stream');
        }
        
        // Store the stream
        const tabCaptureId = `tab-${Date.now()}`;
        capturedStreams.set(tabCaptureId, {
            stream: stream,
            streamId: streamId,
            roomId: roomId,
            server: server,
            type: 'tab'
        });
        
        // Stream captured successfully
        return { 
            success: true, 
            streamId: streamId,
            roomId: roomId,
            tabCaptureId: tabCaptureId,
            message: 'Tab captured successfully'
        };
        
    } catch (error) {
        console.error('Failed to capture tab:', error);
        throw error;
    }
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
            case 'ping':
                sendResponse({ success: true });
                break;
                
            case 'detectVideos':
                initialize();  // Only initialize when first used
                sendResponse(detectVideos());
                break;
        case 'captureVideo':
            initialize();
            captureVideo(request.videoId).then(result => {
                sendResponse(result);
            });
            return true;
            
        case 'captureScreenshot':
            initialize();
            captureScreenshot(request.videoId).then(screenshot => {
                sendResponse(screenshot);
            });
            return true;
            
        case 'startTabCaptureWithStreamId':
            // Handle tab capture with stream ID for Manifest V3
            handleTabCaptureWithStreamId(request).then(result => {
                sendResponse(result);
            }).catch(error => {
                sendResponse({ success: false, error: error.message });
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
            initialize();
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

// Don't automatically start observing - wait for extension to be used
