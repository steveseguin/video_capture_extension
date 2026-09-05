// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

(async () => {
    const root = path.resolve(__dirname, '..');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vdo-extension-test-'));
    const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(request.url === '/frame' ? '<title>Frame video</title><video width="320" height="180"></video>'
            : '<title>Extension test</title><iframe src="/frame"></iframe><iframe src="/frame"></iframe>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let context;
    try {
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true,
            ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
            args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
        });
        let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extensionId = new URL(worker.url()).host;
        const site = await context.newPage();
        await site.goto(`http://127.0.0.1:${server.address().port}`);
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await worker.evaluate(async () => {
            await chrome.storage.local.set({ bitrate: '12500', codec: '', sharper: true, proaudio: true,
                showlabel: false, server: 'https://custom.vdo.ninja', password: 'test' });
        });
        await popup.reload();
        await popup.waitForFunction(() => document.getElementById('bitrate').value === '12500');
        assert.equal(await popup.locator('#codec').inputValue(), '');
        assert.equal(await popup.locator('#sharper').isChecked(), true);
        assert.equal(await popup.locator('#proaudio').isChecked(), true);
        assert.equal(await popup.locator('#vdoServer').inputValue(), 'custom');
        assert.equal(await popup.locator('#customServer').inputValue(), 'https://custom.vdo.ninja');
        await popup.locator('#customServer').evaluate(input => {
            input.value = 'https://example.test'; input.dispatchEvent(new Event('change'));
        });
        assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('server')).server), 'https://example.test');
        console.log('PASS: settings round-trip, Auto codec, custom server editing');

        const refreshCards = await popup.evaluate(async () => {
            const executeScript = chrome.scripting.executeScript;
            const sendMessage = chrome.tabs.sendMessage;
            const tab = currentTab;
            let finishScreenshot, screenshotRequested;
            const requested = new Promise(resolve => { screenshotRequested = resolve; });
            const delayed = new Promise(resolve => { finishScreenshot = resolve; });
            let scans = 0;
            currentTab = { id: 123, url: 'https://example.test' };
            chrome.scripting.executeScript = async () => [{ frameId: 0, result: [{
                id: ++scans === 1 ? 'old-card' : 'new-card', title: 'Refresh test', width: 320, height: 180
            }] }];
            chrome.tabs.sendMessage = async (tabId, message) => {
                if (message.videoId === 'old-card') { screenshotRequested(); return delayed; }
                return null;
            };
            try {
                const older = refreshVideos();
                await requested;
                await refreshVideos();
                finishScreenshot(null);
                await older;
                return Array.from(document.querySelectorAll('#videoList .video-item'), card => card.dataset.videoId);
            } finally {
                chrome.scripting.executeScript = executeScript;
                chrome.tabs.sendMessage = sendMessage;
                currentTab = tab;
            }
        });
        assert.deepEqual(refreshCards, ['new-card']);
        console.log('PASS: popup DOM ignores stale screenshots when refreshes overlap');

        const frames = await worker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
            const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true },
                func: () => {
                    const now = Date.now;
                    try {
                        Date.now = () => 12345;
                        document.querySelectorAll('video').forEach(video => delete video.dataset.vdoCaptureId);
                        return { ready: !!window.vdoFullyLoaded, videos: detectVideos() };
                    } finally { Date.now = now; }
                } });
            return { tabId: tab.id, frames };
        });
        const frame = frames.frames.find(frame => frame.frameId !== 0);
        assert.ok(frame?.result.ready, 'Publisher must be loaded in the child frame');
        assert.equal(frame.result.videos.length, 1);
        const videoIds = frames.frames.flatMap(frame => frame.result.videos.map(video => video.id));
        assert.equal(new Set(videoIds).size, videoIds.length, 'Simultaneous detection in different frames must produce distinct IDs');
        console.log('PASS: actual content scripts detect and initialize iframe publisher');

        await worker.evaluate(async ({ tabId, frameId }) => {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: async () => {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 180;
                const ctx = canvas.getContext('2d');
                window.testDrawTimer = setInterval(() => {
                    ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 320, 180);
                }, 30);
                const video = document.querySelector('video');
                video.muted = true;
                video.srcObject = canvas.captureStream(30);
                await video.play();
                // Keep real media capture and SDK option parsing; isolate signaling.
                VDONinjaSDK.prototype.connect = async function() {};
                VDONinjaSDK.prototype.publish = async function(stream, options) {
                    window.testPublishedTracks = stream.getVideoTracks().length;
                    window.testMediaOptions = await this._extractPublisherMediaOptions(options);
                };
            } });
        }, { tabId: frames.tabId, frameId: frame.frameId });
        const publishResult = await popup.evaluate(({ tabId, frameId, videoId }) => chrome.runtime.sendMessage({
            type: 'startStream', tabId, frameId, videoId, title: 'Local test',
            settings: { streamId: '__proto__', bitrate: '12500', codec: 'vp9' }
        }), { tabId: frames.tabId, frameId: frame.frameId, videoId: frame.result.videos[0].id });
        assert.equal(publishResult.success, true, publishResult.error);
        const published = await worker.evaluate(async ({ tabId, frameId }) => {
            const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] },
                func: () => ({ tracks: window.testPublishedTracks, options: window.testMediaOptions,
                    ownRecord: Object.hasOwn(window.vdoPublishers, '__proto__'),
                    safeDictionary: Object.getPrototypeOf(window.vdoPublishers) === null }) });
            return result.result;
        }, { tabId: frames.tabId, frameId: frame.frameId });
        assert.equal(published.tracks, 1);
        assert.equal(published.options.video.maxBitrate, 12500000);
        assert.equal(published.options.video.codec, 'vp9');
        assert.equal(published.ownRecord, true);
        assert.equal(published.safeDictionary, true);
        const duplicateId = await popup.evaluate(({ tabId, frameId }) => chrome.runtime.sendMessage({
            type: 'startStream', videoId: 'another-video', tabId, frameId, title: 'Another video', settings: { streamId: '__proto__' }
        }), { tabId: frames.tabId, frameId: frame.frameId });
        assert.equal(duplicateId.success, false);
        assert.match(duplicateId.error, /already publishing/);
        const stopped = await popup.evaluate(videoId => chrome.runtime.sendMessage({ type: 'stopStream', videoId }), frame.result.videos[0].id);
        assert.equal(stopped.success, true);
        console.log('PASS: real iframe media capture forwards bitrate and codec through the publisher to SDK parsing');

        const cleanup = await worker.evaluate(async ({ tabId, frameId, videoId }) => {
            const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] },
                func: async videoId => {
                    const originalDisconnect = VDONinjaSDK.prototype.disconnect;
                    const originalAudioContext = window.AudioContext;
                    const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
                    let disconnected = 0, mixingContext;
                    const micContext = new originalAudioContext();
                    const mic = micContext.createMediaStreamDestination().stream;
                    VDONinjaSDK.prototype.disconnect = function() { disconnected++; return originalDisconnect.call(this); };
                    VDONinjaSDK.prototype.publish = async function() { throw Error('Synthetic publishing failure'); };
                    navigator.mediaDevices.getUserMedia = async () => mic;
                    window.AudioContext = class extends originalAudioContext {
                        constructor() { super(); mixingContext = this; }
                        async resume() {} // No user gesture needed for this cleanup-only test.
                    };
                    try {
                        const response = await window.publishVideoToVDO(videoId, 'failed-cleanup', '', 'Cleanup test', '', 'vdo.ninja', { include: true });
                        return { response, disconnected, micStopped: mic.getTracks().every(track => track.readyState === 'ended'),
                            contextClosed: mixingContext.state === 'closed', partialRecord: !!window.vdoPublishers?.['failed-cleanup'],
                            sourceLive: document.querySelector('video').srcObject.getTracks().every(track => track.readyState === 'live') };
                    } finally {
                        window.AudioContext = originalAudioContext;
                        navigator.mediaDevices.getUserMedia = originalGetUserMedia;
                        VDONinjaSDK.prototype.disconnect = originalDisconnect;
                        await micContext.close();
                    }
                }, args: [videoId] });
            return result.result;
        }, { tabId: frames.tabId, frameId: frame.frameId, videoId: frame.result.videos[0].id });
        assert.equal(cleanup.response.success, false);
        assert.equal(cleanup.disconnected, 1);
        assert.equal(cleanup.micStopped, true);
        assert.equal(cleanup.contextClosed, true);
        assert.equal(cleanup.partialRecord, false);
        assert.equal(cleanup.sourceLive, true, 'Failure cleanup must preserve the original page media');
        console.log('PASS: failed publishing disconnects SDK and releases microphone/context while preserving page media');

        const canvasCleanup = await worker.evaluate(async ({ tabId, frameId, videoId }) => {
            const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] },
                func: async videoId => {
                    const video = document.querySelector('video');
                    const requestFrame = window.requestAnimationFrame;
                    const cancelFrame = window.cancelAnimationFrame;
                    const pendingFrames = new Set();
                    // Hide JS capture APIs while retaining the element's real internal playback.
                    Object.defineProperty(video, 'captureStream', { value: undefined, configurable: true });
                    Object.defineProperty(video, 'srcObject', { get: () => null, configurable: true });
                    window.requestAnimationFrame = callback => {
                        const id = requestFrame(time => { pendingFrames.delete(id); callback(time); });
                        pendingFrames.add(id);
                        return id;
                    };
                    window.cancelAnimationFrame = id => { pendingFrames.delete(id); cancelFrame(id); };
                    try {
                        VDONinjaSDK.prototype.publish = async function() {};
                        const started = await window.publishVideoToVDO(videoId, 'canvas-cleanup', '', 'Canvas test');
                        const capture = window.vdoPublishers['canvas-cleanup'].stream;
                        const stopped = await window.stopVDOPublisher('canvas-cleanup');
                        const afterStop = pendingFrames.size;
                        VDONinjaSDK.prototype.publish = async function() { throw Error('Synthetic failure'); };
                        const failed = await window.publishVideoToVDO(videoId, 'canvas-failure', '', 'Canvas failure');
                        return { started, stopped, failed, afterStop, afterFailure: pendingFrames.size,
                            tracksStopped: capture.getTracks().every(track => track.readyState === 'ended') };
                    } finally {
                        for (const id of pendingFrames) cancelFrame(id);
                        window.requestAnimationFrame = requestFrame;
                        window.cancelAnimationFrame = cancelFrame;
                        delete video.captureStream;
                        delete video.srcObject;
                    }
                }, args: [videoId] });
            return result.result;
        }, { tabId: frames.tabId, frameId: frame.frameId, videoId: frame.result.videos[0].id });
        assert.equal(canvasCleanup.started.success, true);
        assert.equal(canvasCleanup.stopped.success, true);
        assert.equal(canvasCleanup.failed.success, false);
        assert.equal(canvasCleanup.afterStop, 0);
        assert.equal(canvasCleanup.afterFailure, 0);
        assert.equal(canvasCleanup.tracksStopped, true);
        console.log('PASS: canvas fallback stops redrawing and releases owned tracks after stop or failure');

        const contentCapture = await worker.evaluate(async ({ tabId, frameId, videoId }) => {
            const inspect = async func => (await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func }))[0].result;
            await inspect(() => Object.defineProperty(document.querySelector('video'), 'captureStream', { value: undefined, configurable: true }));
            try {
                const cloned = await chrome.tabs.sendMessage(tabId, { type: 'captureVideo', videoId }, { frameId });
                await inspect(() => { window.contentTestStream = [...capturedStreams.values()][0].stream; });
                await chrome.tabs.sendMessage(tabId, { type: 'stopCapture', videoId }, { frameId });
                const cloneState = await inspect(() => ({
                    sourceLive: document.querySelector('video').srcObject.getTracks().every(track => track.readyState === 'live'),
                    cloneStopped: window.contentTestStream.getTracks().every(track => track.readyState === 'ended')
                }));
                await inspect(() => Object.defineProperty(document.querySelector('video'), 'captureStream', {
                    value: () => new MediaStream(), configurable: true
                }));
                const fallback = await chrome.tabs.sendMessage(tabId, { type: 'captureVideo', videoId }, { frameId });
                const drawing = await inspect(() => {
                    const capture = [...capturedStreams.values()][0];
                    window.contentTestStream = capture.stream;
                    return capture.frameId != null;
                });
                await chrome.tabs.sendMessage(tabId, { type: 'stopCapture', videoId }, { frameId });
                const fallbackStopped = await inspect(() => window.contentTestStream.getTracks().every(track => track.readyState === 'ended'));
                return { cloned, cloneState, fallback, drawing, fallbackStopped };
            } finally {
                await inspect(() => { delete document.querySelector('video').captureStream; });
            }
        }, { tabId: frames.tabId, frameId: frame.frameId, videoId: frame.result.videos[0].id });
        assert.equal(contentCapture.cloned.hasVideo, true);
        assert.equal(contentCapture.cloneState.sourceLive, true);
        assert.equal(contentCapture.cloneState.cloneStopped, true);
        assert.equal(contentCapture.fallback.hasVideo, true);
        assert.equal(contentCapture.drawing, true);
        assert.equal(contentCapture.fallbackStopped, true);
        console.log('PASS: content-script capture messages preserve source media and start/stop canvas fallback correctly');

        await worker.evaluate(async ({ tabId, frameId }) => {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => {
                VDONinjaSDK.prototype.connect = () => new Promise(resolve => { window.finishLateConnection = resolve; });
                VDONinjaSDK.prototype.publish = async function() {};
                window.lateCleanup = new Promise(resolve => {
                    const handler = event => {
                        if (event.detail?.error !== 'Publish request cancelled') return;
                        window.removeEventListener('vdo-publish-response', handler);
                        resolve(!window.vdoPublishers?.['late-runtime']);
                    };
                    window.addEventListener('vdo-publish-response', handler);
                });
            } });
        }, { tabId: frames.tabId, frameId: frame.frameId });
        const timedOut = await popup.evaluate(({ tabId, frameId, videoId }) => chrome.runtime.sendMessage({
            type: 'startStream', tabId, frameId, videoId, title: 'Late publish', settings: { streamId: 'late-runtime' }
        }), { tabId: frames.tabId, frameId: frame.frameId, videoId: frame.result.videos[0].id });
        assert.equal(timedOut.success, false);
        assert.match(timedOut.error, /timed out/);
        const lateCleaned = await worker.evaluate(async ({ tabId, frameId }) => {
            const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: async () => {
                window.finishLateConnection();
                return await window.lateCleanup;
            } });
            return result.result;
        }, { tabId: frames.tabId, frameId: frame.frameId });
        assert.equal(lateCleaned, true);
        console.log('PASS: reused stream IDs are rejected and publishing after the real timeout cleans up its publisher');

        await worker.evaluate(async ({ tabId, frameId }) => {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => {
                window.testPublishCalls = 0;
                window.publishVideoToVDO = async videoId => {
                    window.testPublishCalls++;
                    await new Promise(resolve => setTimeout(resolve, videoId === 'fails' ? 20 : 100));
                    return videoId === 'fails' ? { success: false, error: 'Expected test failure' } : { success: true };
                };
            } });
        }, { tabId: frames.tabId, frameId: frame.frameId });
        const concurrent = await popup.evaluate(({ tabId, frameId }) => Promise.all(['fails', 'succeeds', 'succeeds'].map(videoId =>
            chrome.runtime.sendMessage({ type: 'startStream', tabId, frameId, videoId, title: videoId, settings: { streamId: videoId } })
        )), { tabId: frames.tabId, frameId: frame.frameId });
        assert.equal(concurrent[0].success, false);
        assert.equal(concurrent[1].success, true, `Other publish responses must not resolve this request: ${JSON.stringify(concurrent)}`);
        assert.equal(concurrent[2].success, true);
        const publishCalls = await worker.evaluate(async ({ tabId, frameId }) => {
            const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => window.testPublishCalls });
            return result.result;
        }, { tabId: frames.tabId, frameId: frame.frameId });
        assert.equal(publishCalls, 2, 'Double clicks must share one pending publisher');
        await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'stopStream', videoId: 'succeeds' }));
        console.log('PASS: concurrent publishes receive their own result and duplicate starts publish once');

        // Seed bookkeeping without connecting to a public streaming service.
        await worker.evaluate(async ({ tabId, frameId }) => {
            await stateReady;
            activePublishers.set('runtime-video', { tabId, frameId, streamId: 'runtime-stream', server: 'vdo.ninja' });
            activeTabs.set(999, { streamId: 'runtime-tab', server: 'vdo.ninja' });
            await savePublisherState();
        }, { tabId: frames.tabId, frameId: frame.frameId });
        const cdp = await context.newCDPSession(popup);
        let versions = [];
        cdp.on('ServiceWorker.workerVersionUpdated', event => { versions.push(...event.versions); });
        await cdp.send('ServiceWorker.enable');
        for (let i = 0; i < 100 && !versions.some(v => v.scriptURL === worker.url()); i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const version = versions.findLast(v => v.scriptURL === worker.url());
        assert.ok(version, 'CDP must locate the actual extension worker');
        await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
        const streams = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'getActiveStreams' }));
        assert.equal(streams.length, 2);
        assert.ok(streams.some(stream => stream.id === 'runtime-video'));
        assert.ok(streams.some(stream => stream.id === 'tab-999'));
        console.log('PASS: active video and tab controls survive actual worker termination');

        worker = context.serviceWorkers().find(w => w.url().includes(extensionId)) || await context.waitForEvent('serviceworker');
        // Return a synthetic frame from the real iframe bridge to verify routing.
        await worker.evaluate(async ({ tabId, frameId }) => {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => {
                window.getVDOPublisherThumbnail = async () => ({ success: true, dataUrl: 'iframe-thumbnail' });
            } });
        }, { tabId: frames.tabId, frameId: frame.frameId });
        const thumbnail = await popup.evaluate(({ tabId, frameId }) => chrome.runtime.sendMessage({
            type: 'getStreamThumbnail', tabId, frameId, streamId: 'runtime-stream'
        }), { tabId: frames.tabId, frameId: frame.frameId });
        assert.equal(thumbnail.dataUrl, 'iframe-thumbnail');
        console.log('PASS: thumbnail requests reach the owning iframe');

        await worker.evaluate(async () => {
            await Promise.all([ensureOffscreenDocument(), ensureOffscreenDocument()]);
            await ensureOffscreenDocument();
        });
        const browserCdp = await context.browser().newBrowserCDPSession();
        const { targetInfos } = await browserCdp.send('Target.getTargets');
        const offscreenTarget = targetInfos.find(target => target.url === `chrome-extension://${extensionId}/offscreen.html`);
        assert.ok(offscreenTarget, 'Actual offscreen document must exist');
        const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: offscreenTarget.targetId });
        let nextCommand = 0;
        const evaluateOffscreen = expression => new Promise((resolve, reject) => {
            const id = ++nextCommand;
            const onMessage = event => {
                if (event.sessionId !== sessionId) return;
                const response = JSON.parse(event.message);
                if (response.id !== id) return;
                browserCdp.off('Target.receivedMessageFromTarget', onMessage);
                if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)));
                else resolve(response.result.result.value);
            };
            browserCdp.on('Target.receivedMessageFromTarget', onMessage);
            browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate',
                params: { expression, awaitPromise: true, returnByValue: true } }) }).catch(reject);
        });
        await evaluateOffscreen(`
            navigator.mediaDevices.getUserMedia = async () => {
                const canvas = document.createElement('canvas');
                canvas.width = 32; canvas.height = 32;
                window.testCaptureStream = canvas.captureStream(30);
                return window.testCaptureStream;
            };
            VDONinjaSDK.prototype.connect = () => new Promise(resolve => { window.finishTestConnection = resolve; });
            VDONinjaSDK.prototype.publish = async () => {};
            true;
        `);
        await popup.evaluate(() => {
            window.pendingOffscreenStart = chrome.runtime.sendMessage({ target: 'offscreen', type: 'startTabCapture', tabId: 4321,
                video: true, streamId: 'cancel-test', settings: {} });
        });
        for (let i = 0; i < 100 && !await evaluateOffscreen('!!window.finishTestConnection'); i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(await evaluateOffscreen('!!window.finishTestConnection'), true);
        const cancelled = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopTabCapture', tabId: 4321 }));
        assert.equal(cancelled.success, true);
        assert.equal(await evaluateOffscreen('window.testCaptureStream.getTracks().every(track => track.readyState === "ended")'), true);
        await evaluateOffscreen('window.finishTestConnection(); true;');
        assert.equal((await popup.evaluate(() => window.pendingOffscreenStart)).success, false);
        assert.equal(await evaluateOffscreen('mediaStream === null && vdoPublisher === null && !captureStarting'), true);
        await worker.evaluate(() => chrome.offscreen.closeDocument());
        console.log('PASS: actual offscreen document cancels pending startup and stops its real media tracks');
        await popup.setViewportSize({ width: 420, height: 720 });
        await popup.evaluate(() => {
            document.querySelector('[data-tab="tab"]').click();
            showNotification('Capture settings saved. Ready to publish.');
        });
        assert.equal(await popup.locator('#notification').isVisible(), true);
        assert.equal(await popup.locator('#extensionVersion').textContent(), `v${JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version}`);
        assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= 420), true);
        await popup.locator('#refreshBtn').focus();
        assert.equal(await popup.locator('#refreshBtn').evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
        if (process.env.POPUP_SCREENSHOT_PATH) await popup.screenshot({ path: process.env.POPUP_SCREENSHOT_PATH, fullPage: true });
        console.log('PASS: popup status, version, keyboard focus, and 420px layout');
    } finally {
        await context?.close();
        await new Promise(resolve => server.close(resolve));
        // Delete only the isolated test profile created above.
        assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(profile).startsWith('vdo-extension-test-'));
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
