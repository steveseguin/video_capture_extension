const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function application() {
    const window = new EventTarget();
    class CustomEvent extends Event {
        constructor(type, { detail }) { super(type); this.detail = detail; }
    }
    const track = new EventTarget();
    Object.assign(track, { kind: 'video', readyState: 'live', id: 'source' });
    const stream = new EventTarget();
    Object.assign(stream, {
        getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => []
    });
    const video = new EventTarget();
    Object.assign(video, {
        dataset: { vdoCaptureId: 'video' }, captureStream: () => stream,
        isConnected: true, readyState: 4, videoWidth: 320, videoHeight: 180
    });
    const firstConnection = deferred();
    const cancelled = deferred();
    const publishers = [];
    const notifications = [];
    const globals = { window, CustomEvent, crypto: webcrypto,
        console: { log() {}, error() {}, warn() {} },
        setTimeout: (fn, ms) => setTimeout(fn, ms === 10000 ? 10 : ms), clearTimeout };
    let background;
    const sender = { tab: { id: 12 }, frameId: 0 };
    const page = vm.createContext({ ...globals,
        VDONinja: class {
            constructor() { publishers.push(this); }
            connect() { return publishers.length === 1 ? firstConnection.promise : Promise.resolve(); }
            async publish() {}
            sendData() {}
            async disconnect() { this.disconnected = true; }
        },
        MutationObserver: class { observe() {} disconnect() {} },
        document: { querySelector: () => video, contains: () => true, documentElement: {} },
        chrome: { runtime: { sendMessage: async message => {
            notifications.push(message);
            await background.handleMessage(message, sender);
            cancelled.resolve();
        } } }
    });
    const bundle = fs.readFileSync(path.join(__dirname, '../combined-vdo-scripts.js'), 'utf8');
    vm.runInContext(bundle.slice(bundle.indexOf('// Setting up VDO publisher functions...')), page);
    background = vm.createContext({ ...globals, chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: { session: { get: async () => ({}), set: async () => {} } },
        tabs: { onRemoved: { addListener() {} }, get: async () => ({}), sendMessage: async () => {} },
        scripting: { executeScript: async ({ func, args = [] }) => {
            page.args = args;
            return [{ result: await vm.runInContext(`(${func.toString()})(...args)`, page) }];
        } }
    } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), background);
    return { window, background, firstConnection, cancelled, publishers, notifications, sender };
}

const request = streamId => ({ videoId: 'video', tabId: 12, frameId: 0,
    title: 'Video', settings: { streamId } });

test('late cleanup of a timed-out start does not hide a successful retry', async () => {
    const app = application();
    const first = await app.background.startVideoStream(request('old_stream'));
    assert.equal(first.success, false);
    assert.match(first.error, /timed out/);
    assert.equal((await app.background.startVideoStream(request('new_stream'))).success, true);
    app.firstConnection.resolve();
    await app.cancelled.promise;
    assert.equal(app.publishers[0].disconnected, true);
    assert.equal(app.publishers[1].disconnected, undefined);
    assert.equal(app.background.getActiveStreams()[0]?.streamId, 'new_stream');
    assert.equal((await app.background.stopVideoStream({ videoId: 'video' })).success, true);
    assert.equal(app.publishers[1].disconnected, true);
});


test('publisher-ended messages only remove the matching tab, frame, and stream', async () => {
    const app = application();
    // Start the normal publisher without delaying its connection.
    app.firstConnection.resolve();
    assert.equal((await app.background.startVideoStream(request('current'))).success, true);
    const ended = { type: 'publisherEnded', videoId: 'video', streamId: 'current' };
    for (const [message, sender] of [
        [{ ...ended, streamId: 'previous' }, app.sender],
        [ended, { tab: { id: 99 }, frameId: 0 }],
        [ended, { tab: { id: 12 }, frameId: 7 }],
        [ended, {}]
    ]) {
        await app.background.handleMessage(message, sender);
        assert.equal(app.background.getActiveStreams().length, 1);
    }
    await app.background.handleMessage(ended, app.sender);
    assert.equal(app.background.getActiveStreams().length, 0);
});

test('page unload identifies every publisher it retires', async () => {
    const app = application();
    app.firstConnection.resolve();
    await app.background.startVideoStream(request('current'));
    app.window.dispatchEvent(new Event('pagehide'));
    await app.cancelled.promise;
    assert.equal(app.notifications[0].streamId, 'current');
    assert.equal(app.background.getActiveStreams().length, 0);
});

test('fallback teardown identifies the publisher it retires', async () => {
    const app = application();
    app.firstConnection.resolve();
    await app.background.startVideoStream(request('current'));
    delete app.window.vdoPublishers.current.cleanup;
    await app.window.stopVDOPublisher('current');
    assert.equal(app.notifications[0].streamId, 'current');
    assert.equal(app.background.getActiveStreams().length, 0);
});
