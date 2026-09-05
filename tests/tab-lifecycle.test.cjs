const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function app() {
    let listener;
    const captures = [];
    const events = [];
    const notifications = [];
    let connect = async () => {};
    const context = vm.createContext({ console: { error() {} }, setTimeout, clearTimeout,
        window: { addEventListener(type) { events.push(type); } },
        navigator: { mediaDevices: { getUserMedia: async () => {
            const listeners = new Map();
            const track = { readyState: 'live', stop() { this.readyState = 'ended'; },
                addEventListener(type, callback) { listeners.set(type, callback); },
                removeEventListener(type) { listeners.delete(type); } };
            const stream = { getTracks: () => [track], getAudioTracks: () => [], getVideoTracks: () => [track] };
            captures.push({ stream, track, listeners });
            return stream;
        } } },
        VDONinja: class {
            addEventListener() {} connect() { return connect(); } async publish() {}
            sendData() {} disconnect() {}
        },
        chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
            sendMessage: async message => { notifications.push(message); } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../offscreen.js'), 'utf8'), context);
    return { context, captures, events, notifications,
        connect: fn => { connect = fn; },
        send: request => new Promise(resolve => listener(request, {}, resolve)) };
}
const start = { target: 'offscreen', type: 'startTabCapture', tabId: 12, video: true, settings: {} };
const stop = { target: 'offscreen', type: 'stopTabCapture', tabId: 12 };

test('a queued ended event from a stopped capture cannot stop a replacement capture', async () => {
    const testApp = app();
    await testApp.send(start);
    const oldEnded = testApp.captures[0].listeners.get('ended');
    await testApp.send(stop);
    await testApp.send({ ...start, tabId: 99 });
    oldEnded();
    assert.equal(testApp.captures[1].track.readyState, 'live');
    assert.equal(testApp.notifications.length, 0);
});

test('stop cancels pending connection and its late completion cannot overwrite a new capture', async () => {
    const testApp = app();
    const pending = deferred();
    testApp.connect(() => pending.promise);
    const first = testApp.send(start);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await testApp.send(stop)).success, true);
    assert.equal(testApp.captures[0].track.readyState, 'ended');
    testApp.connect(async () => {});
    assert.equal((await testApp.send({ ...start, tabId: 99 })).success, true);
    pending.resolve();
    assert.equal((await first).success, false);
    assert.equal(testApp.captures[1].track.readyState, 'live');
    assert.equal(vm.runInContext('sourceTabId', testApp.context), 99);
});

test('track ending during startup cannot report a successful dead capture', async () => {
    const testApp = app();
    const pending = deferred();
    testApp.connect(() => pending.promise);
    const first = testApp.send(start);
    await new Promise(resolve => setImmediate(resolve));
    const capture = testApp.captures[0];
    capture.track.readyState = 'ended';
    capture.listeners.get('ended')?.();
    pending.resolve();
    assert.equal((await first).success, false);
});

test('repeated captures do not accumulate unload handlers', async () => {
    const testApp = app();
    await testApp.send(start);
    await testApp.send(stop);
    await testApp.send(start);
    assert.equal(testApp.events.filter(type => type === 'pagehide').length, 1);
    assert.equal(testApp.events.filter(type => type === 'beforeunload').length, 1);
});

function backgroundApp() {
    let removed;
    const media = deferred();
    const started = deferred();
    const captureResult = deferred();
    const messages = [];
    const context = vm.createContext({ console: { error() {} }, setTimeout: callback => setTimeout(callback, 0),
        chrome: {
            runtime: { onMessage: { addListener() {} }, getURL: file => `chrome-extension://test/${file}`, getContexts: async () => [], sendMessage: (message, callback) => {
                messages.push(message);
                if (message.type === 'startTabCapture') {
                    started.resolve();
                    captureResult.promise.then(callback);
                } else return Promise.resolve({ success: true });
            } },
            tabs: { get: async () => ({ title: 'Tab' }), onRemoved: { addListener(fn) { removed = fn; } } },
            storage: { session: { get: async () => ({}), set: async () => {} } },
            tabCapture: { getMediaStreamId: (options, callback) => media.promise.then(callback) },
            offscreen: { createDocument: async () => {} }
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
    return { context, media, started, captureResult, messages, close: () => removed(12) };
}

test('closing a tab before its media token arrives prevents a later offscreen start', async () => {
    const app = backgroundApp();
    const pending = app.context.startTabCapture({ tabId: 12, video: true, settings: {} });
    await app.close();
    app.media.resolve('token');
    // Baseline code would otherwise wait for this response after wrongly starting.
    app.captureResult.resolve({ success: true });
    assert.equal((await pending).success, false);
    assert.equal(app.messages.some(message => message.type === 'startTabCapture'), false);
});

test('closing a tab during offscreen startup cancels it and cannot create a ghost stream', async () => {
    const app = backgroundApp();
    const pending = app.context.startTabCapture({ tabId: 12, video: true, settings: {} });
    app.media.resolve('token');
    await app.started.promise;
    await app.close();
    app.captureResult.resolve({ success: true });
    assert.equal((await pending).success, false);
    assert.equal(app.messages.some(message => message.type === 'stopTabCapture'), true);
    assert.equal(vm.runInContext('activeTabs.size', app.context), 0);
});
