const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function load(file, globals = {}) {
    let listener;
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, crypto: require('node:crypto').webcrypto,
        chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
            getURL: file => `chrome-extension://test/${file}`, getContexts: async () => [] },
            storage: { session: { get: async () => ({}), set: async () => {} } },
            tabs: { onRemoved: { addListener() {} } } }, ...globals
    });
    vm.runInContext(read(file), context);
    return { context, get listener() { return listener; } };
}

test('both SDK copies match and expose the expected API', () => {
    const sdk = read('vdoninja-sdk.js');
    assert.ok(read('combined-vdo-scripts.js').startsWith(sdk + '\n\n// Setting up VDO publisher functions...'));
    const SDK = require('../vdoninja-sdk.js');
    assert.equal(SDK.VERSION, '1.6.0');
    for (const method of ['connect', 'joinRoom', 'publish', 'disconnect', 'sendData']) {
        assert.equal(typeof SDK.prototype[method], 'function');
    }
});

test('background leaves offscreen requests to their intended receiver', () => {
    const app = load('background.js');
    assert.equal(app.listener({ target: 'offscreen', type: 'stopTabCapture' }, {}, () => assert.fail()), false);
});

test('stopping tab capture routes to offscreen and retains state on failure', async () => {
    const app = load('background.js');
    vm.runInContext('activeTabs.set(12, { streamId: "test" })', app.context);
    let message;
    app.context.chrome.runtime.sendMessage = async request => { message = request; return { success: false }; };
    assert.equal((await app.context.stopTabCapture({ tabId: 12 })).success, false);
    assert.equal(vm.runInContext('activeTabs.has(12)', app.context), true);
    app.context.chrome.runtime.sendMessage = async request => { message = request; return { success: true }; };
    assert.equal((await app.context.stopTabCapture({ tabId: 12 })).success, true);
    assert.equal(message.target, 'offscreen');
    assert.equal(message.tabId, 12);
    assert.equal(vm.runInContext('activeTabs.has(12)', app.context), false);
});

test('video stop uses the owning tab even if popup supplies another tab', async () => {
    const app = load('background.js');
    vm.runInContext('activePublishers.set("video", { tabId: 12, frameId: 3, streamId: "test" })', app.context);
    let target;
    app.context.chrome.scripting = { executeScript: async request => { target = request.target; return [{ result: { success: true } }]; } };
    app.context.chrome.tabs.sendMessage = async tabId => assert.equal(tabId, 12);
    assert.equal((await app.context.stopVideoStream({ videoId: 'video', tabId: 99 })).success, true);
    assert.equal(target.tabId, 12);
    assert.equal(target.frameIds[0], 3);
});

function offscreen(failPublish = false) {
    let stopped = 0, disconnected = 0;
    let publishOptions;
    const track = { stop() { stopped++; }, addEventListener() {} };
    const stream = { getTracks: () => [track], getAudioTracks: () => [], getVideoTracks: () => [track] };
    class SDK {
        addEventListener() {} async connect() {} async publish(stream, options) { publishOptions = options; if (failPublish) throw Error('Publish failed'); }
        disconnect() { disconnected++; } sendData() {}
    }
    const app = load('offscreen.js', { VDONinja: SDK, window: { addEventListener() {} },
        navigator: { mediaDevices: { getUserMedia: async () => stream } } });
    const send = request => new Promise(resolve => app.listener(request, {}, resolve));
    return { app, send, counts: () => ({ stopped, disconnected }), options: () => publishOptions };
}
const start = { target: 'offscreen', type: 'startTabCapture', tabId: 12, video: true, settings: {} };

test('failed publishing reports failure and releases capture resources', async () => {
    const app = offscreen(true);
    assert.equal((await app.send(start)).success, false);
    assert.deepEqual(app.counts(), { stopped: 1, disconnected: 1 });
    assert.equal(vm.runInContext('mediaStream', app.app.context), null);
});

test('a second capture cannot overwrite the first and wrong-tab stops cannot end it', async () => {
    const app = offscreen();
    assert.equal((await app.send(start)).success, true);
    assert.equal((await app.send({ ...start, tabId: 99 })).success, false);
    assert.equal((await app.send({ target: 'offscreen', type: 'stopTabCapture', tabId: 99 })).success, false);
    assert.deepEqual(app.counts(), { stopped: 0, disconnected: 0 });
    assert.equal((await app.send({ target: 'offscreen', type: 'stopTabCapture', tabId: 12 })).success, true);
    assert.deepEqual(app.counts(), { stopped: 1, disconnected: 1 });
});

test('popup escapes page-controlled text and attributes', () => {
    const app = load('popup.js', { document: { addEventListener() {} } });
    assert.equal(app.context.escapeHtml('<img src="x"> & \'title\''), '&lt;img src=&quot;x&quot;&gt; &amp; &#39;title&#39;');
});

test('audio-only capture thumbnails fail promptly rather than hanging', async () => {
    const app = offscreen();
    vm.runInContext('mediaStream = { getVideoTracks: () => [] }', app.app.context);
    assert.equal((await app.send({ type: 'getTabThumbnail' })).success, false);
});

test('thumbnail readiness events produce one response and release the video', async () => {
    const app = offscreen();
    await app.send(start);
    const events = {};
    let paused = 0;
    const video = {
        addEventListener(type, callback) { events[type] = callback; },
        play: async () => {}, pause() { paused++; },
        requestVideoFrameCallback(callback) { callback(); }
    };
    app.app.context.document = { createElement: tag => tag === 'video' ? video : {
        getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,test'
    } };
    const responses = [];
    app.app.listener({ type: 'getTabThumbnail' }, {}, response => responses.push(response));
    events.loadeddata();
    events.playing();
    assert.equal(responses.length, 1);
    assert.equal(responses[0].success, true);
    assert.equal(paused, 1);
    assert.equal(video.srcObject, null);
});

test('tab quality settings use SDK-supported options with unambiguous bitrate units', async () => {
    const app = offscreen();
    await app.send({ ...start, settings: { bitrate: '12500', codec: 'vp9' } });
    const SDK = require('../vdoninja-sdk.js');
    const parsed = await SDK.prototype._extractPublisherMediaOptions.call(SDK.prototype, app.options());
    assert.equal(parsed.video.maxBitrate, 12500000);
    assert.equal(parsed.video.codec, 'vp9');
    const automatic = offscreen();
    await automatic.send({ ...start, settings: { codec: '' } });
    assert.equal(automatic.options().videoCodec, undefined);
});

test('popup synchronization preserves thumbnail cache and in-flight objects', async () => {
    const app = load('popup.js', { document: { addEventListener() {} } });
    vm.runInContext(`
        activeStreams.set('video', { streamId: 'stream', thumb: 'cached', lastThumbAt: 123, thumbPending: true });
        globalThis.previousEntry = activeStreams.get('video');
        saveActiveStreams = () => {};
        refreshThumbnails = throttle => { globalThis.usedThrottle = throttle; };
    `, app.context);
    app.context.chrome.runtime.sendMessage = async () => [{ id: 'video', streamId: 'stream', title: 'Updated' }];
    await app.context.syncWithBackground();
    assert.equal(vm.runInContext('activeStreams.get("video") === previousEntry', app.context), true);
    assert.equal(app.context.previousEntry.thumb, 'cached');
    assert.equal(app.context.previousEntry.title, 'Updated');
    assert.equal(app.context.usedThrottle, true);
});

test('both popup stop actions keep failed streams available for retry', async () => {
    const app = load('popup.js', { document: { addEventListener() {} } });
    vm.runInContext('activeStreams.set("video", { tabId: 12 })', app.context);
    app.context.chrome.runtime.sendMessage = async () => ({ success: false, error: 'Stop failed' });
    await app.context.stopStream('video');
    assert.equal(vm.runInContext('activeStreams.has("video")', app.context), true);
    await app.context.stopActiveStream('video');
    assert.equal(vm.runInContext('activeStreams.has("video")', app.context), true);
});

test('publisher IDs and viewer links match SDK normalization, including length limits', async () => {
    const app = load('background.js');
    const SDK = require('../vdoninja-sdk.js');
    const sdk = { _log() {} };
    const rawStream = '  camera & one-' + 'x'.repeat(70);
    const rawRoom = '  room # one-' + 'y'.repeat(40);
    const streamId = SDK.prototype._sanitizeStreamID.call(sdk, rawStream);
    const roomId = SDK.prototype._sanitizeRoomName.call(sdk, rawRoom);
    let publishArgs;
    app.context.chrome.scripting = { executeScript: async ({ args }) => {
        if (args) publishArgs = args;
        return [{ result: args ? { success: true } : true }];
    } };
    const result = await app.context.startVideoStream({ videoId: 'video', tabId: 12, title: 'Title',
        settings: { streamId: rawStream, roomId: rawRoom } });
    assert.equal(result.success, true);
    assert.equal(result.streamId, streamId);
    assert.equal(result.roomId, roomId);
    assert.equal(publishArgs[1], streamId);
    assert.equal(publishArgs[2], roomId);
    const link = new URL(result.links[0].url);
    assert.equal(link.searchParams.get('view'), streamId);
    assert.equal(link.searchParams.get('room'), roomId);
    assert.equal(link.hash, '');
});

test('whitespace-only stream IDs use one generated ID throughout publishing and bookkeeping', async () => {
    const app = load('background.js');
    let args;
    app.context.chrome.scripting = { executeScript: async request => {
        if (request.args) args = request.args;
        return [{ result: request.args ? { success: true } : true }];
    } };
    const result = await app.context.startVideoStream({ videoId: 'video', tabId: 12, title: 'Title', settings: { streamId: '  ', roomId: '  ' } });
    assert.match(result.streamId, /^stream_\w+$/);
    assert.equal(args[1], result.streamId);
    assert.equal(result.roomId, '');
    assert.equal(result.links.length, 1);
});

test('tab capture sends the same canonical IDs to offscreen and viewer links', async () => {
    const app = load('background.js');
    app.context.chrome.tabs.get = async () => ({ title: 'Tab' });
    app.context.chrome.tabCapture = { getMediaStreamId: (options, callback) => callback('media-token') };
    app.context.chrome.offscreen = { createDocument: async () => {} };
    let sent;
    app.context.chrome.runtime.sendMessage = (message, callback) => { sent = message; callback({ success: true }); };
    const result = await app.context.startTabCapture({ tabId: 12, audio: false, video: true,
        settings: { streamId: ' camera # 1 ', roomId: ' room & 2 ' } });
    assert.equal(result.success, true);
    assert.equal(sent.streamId, 'camera_1');
    assert.equal(sent.roomId, 'room_2');
    const link = new URL(result.links[0].url);
    assert.equal(link.searchParams.get('view'), sent.streamId);
    assert.equal(link.searchParams.get('room'), sent.roomId);
});

test('viewer-link values cannot introduce extra query parameters or fragments', () => {
    const app = load('background.js');
    const [direct, room] = app.context.getVdoLinks('vdo.ninja', 'legacy#room', 'legacy&stream', { codec: 'vp9&extra=1' });
    const link = new URL(direct.url);
    assert.equal(link.searchParams.get('view'), 'legacy&stream');
    assert.equal(link.searchParams.get('room'), 'legacy#room');
    assert.equal(link.searchParams.get('codec'), 'vp9&extra=1');
    assert.equal(link.searchParams.has('extra'), false);
    assert.equal(link.hash, '');
    assert.equal(new URL(room.url).searchParams.get('room'), 'legacy#room');
});

test('offscreen creation errors are returned without attempting to start capture', async () => {
    const app = load('background.js');
    app.context.chrome.tabs.get = async () => ({ title: 'Tab' });
    app.context.chrome.tabCapture = { getMediaStreamId: (options, callback) => callback('token') };
    app.context.chrome.offscreen = { createDocument: async () => { throw Error('Offscreen creation failed'); } };
    let sent = false;
    app.context.chrome.runtime.sendMessage = (message, callback) => { sent = true; callback({ success: true }); };
    const result = await app.context.startTabCapture({ tabId: 12, video: true, settings: {} });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Offscreen creation failed');
    assert.equal(sent, false);
});

test('existing offscreen documents are reused without a failing creation attempt', async () => {
    const app = load('background.js');
    app.context.chrome.tabs.get = async () => ({ title: 'Tab' });
    app.context.chrome.tabCapture = { getMediaStreamId: (options, callback) => callback('token') };
    app.context.chrome.runtime.getContexts = async () => [{ documentUrl: 'chrome-extension://test/offscreen.html' }];
    let created = false;
    app.context.chrome.offscreen = { createDocument: async () => { created = true; } };
    app.context.chrome.runtime.sendMessage = (message, callback) => callback({ success: true });
    const result = await app.context.startTabCapture({ tabId: 12, video: true, settings: {} });
    assert.equal(result.success, true);
    assert.equal(created, false);
});
