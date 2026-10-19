const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceKey = 'discordStream:123456789012345678:camera';

function application() {
    const window = new EventTarget();
    class CustomEvent extends Event { constructor(type, { detail }) { super(type); this.detail = detail; } }
    const globals = { window, CustomEvent, crypto: webcrypto,
        console: { log() {}, error() {}, warn() {} },
        setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout };
    const page = vm.createContext(globals);
    const bundle = fs.readFileSync(path.join(root, 'combined-vdo-scripts.js'), 'utf8');
    const bridge = bundle.indexOf('(function() {', bundle.indexOf('// Bridge script'));
    assert.ok(bridge > 0);
    vm.runInContext(bundle.slice(bridge), page);
    page.getDiscordPersistentSourceKey = () => sourceKey;
    window.vdoPublishers = {};
    window.publishVideoToVDO = async (videoId, streamId) => {
        window.vdoPublishers[streamId] = { videoId };
        return { success: true };
    };
    window.stopVDOPublisher = async streamId => {
        delete window.vdoPublishers[streamId];
        return { success: true };
    };
    const stored = new Map();
    const app = { window, stored, document: 'doc-1', goneDocuments: new Set(), unscriptableTabs: new Set() };
    const background = vm.createContext({ ...globals, chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: {
            session: { get: async () => ({}), set: async () => {} },
            local: {
                get: async key => stored.has(key) ? { [key]: stored.get(key) } : {},
                set: async values => { for (const [key, value] of Object.entries(values)) stored.set(key, value); }
            }
        },
        tabs: { onRemoved: { addListener() {} }, get: async () => ({}), sendMessage: async () => {} },
        scripting: { executeScript: async ({ target, func, args = [] }) => {
            if (app.unscriptableTabs.has(target.tabId)) throw Error('Cannot access contents of the page');
            if (target.documentIds?.some(id => app.goneDocuments.has(id))) throw Error('No document with id');
            page.args = args;
            return [{ documentId: app.document, result: await vm.runInContext(`(${func.toString()})(...args)`, page) }];
        } }
    } });
    vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), background);
    app.background = background;
    return app;
}
const request = (videoId, settings = {}, tabId = 12) => ({ videoId, tabId, frameId: 0, title: videoId, settings });

test('a blank stream ID reuses the remembered Discord link for a later capture', async () => {
    const app = application();
    const first = await app.background.startVideoStream(request('first'));
    assert.equal(first.success, true, first.error);
    assert.match(first.streamId, /^stream_[0-9a-f]{32}$/);
    assert.equal(app.stored.get(sourceKey), first.streamId);
    assert.equal((await app.background.stopVideoStream({ videoId: 'first' })).success, true);
    const second = await app.background.startVideoStream(request('second'));
    assert.equal(second.success, true, second.error);
    assert.equal(second.streamId, first.streamId);
});

test('an explicit stream ID overrides and does not replace the remembered link', async () => {
    const app = application();
    app.stored.set(sourceKey, 'stream_saved');
    const result = await app.background.startVideoStream(request('manual', { streamId: 'manual_id' }));
    assert.equal(result.success, true, result.error);
    assert.equal(result.streamId, 'manual_id');
    assert.equal(app.stored.get(sourceKey), 'stream_saved');
});

test('a live publisher for the same Discord source blocks a second capture', async () => {
    const app = application();
    assert.equal((await app.background.startVideoStream(request('first'))).success, true);
    const second = await app.background.startVideoStream(request('second'));
    assert.equal(second.success, false);
    assert.match(second.error, /already publishing/);
});

test('a publisher whose page was unloaded no longer blocks its Discord source', async () => {
    const app = application();
    const first = await app.background.startVideoStream(request('first'));
    assert.equal(first.success, true, first.error);
    // The old tab moved to a page the extension cannot script, with no unload notice.
    app.unscriptableTabs.add(12);
    app.goneDocuments.add('doc-1');
    app.document = 'doc-2';
    delete app.window.vdoPublishers[first.streamId];
    const second = await app.background.startVideoStream(request('second', {}, 13));
    assert.equal(second.success, true, second.error);
    assert.equal(second.streamId, first.streamId);
    assert.equal(vm.runInContext('activePublishers.has("first")', app.background), false);
});

test('stopping a publisher whose page was unloaded removes its controls', async () => {
    const app = application();
    assert.equal((await app.background.startVideoStream(request('first'))).success, true);
    app.unscriptableTabs.add(12);
    app.goneDocuments.add('doc-1');
    const stopped = await app.background.stopVideoStream({ videoId: 'first' });
    assert.equal(stopped.success, true, stopped.error);
    assert.equal(vm.runInContext('activePublishers.size', app.background), 0);
});

test('forgetting Discord links removes only remembered Discord assignments', async () => {
    const stored = { [sourceKey]: 'stream_saved', 'discordStream:223456789012345678:screen': 'stream_other', streamId: 'kept', bitrate: '6000' };
    const notices = [];
    const popup = vm.createContext({ console: { log() {}, error() {} }, document: { addEventListener() {} }, chrome: {
        storage: { local: {
            get: async () => ({ ...stored }),
            remove: async keys => { for (const key of keys) delete stored[key]; }
        } }
    } });
    vm.runInContext(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), popup);
    popup.showNotification = message => notices.push(message);
    await popup.forgetDiscordLinks();
    assert.deepEqual(Object.keys(stored).sort(), ['bitrate', 'streamId']);
    assert.deepEqual(notices, ['Forgot 2 remembered Discord links']);
});
