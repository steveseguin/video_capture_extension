const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');

function application({ publishTimeout = 10000 } = {}) {
    const window = new EventTarget();
    class CustomEvent extends Event { constructor(type, { detail }) { super(type); this.detail = detail; } }
    const globals = { window, CustomEvent, crypto: webcrypto,
        console: { log() {}, error() {}, warn() {} },
        setTimeout: (fn, ms) => setTimeout(fn, ms === 10000 ? publishTimeout : ms).unref(), clearTimeout };
    const page = vm.createContext(globals);
    const bundle = fs.readFileSync(path.join(root, 'combined-vdo-scripts.js'), 'utf8');
    const bridge = bundle.indexOf('(function() {', bundle.indexOf('// Bridge script'));
    assert.ok(bridge > 0);
    vm.runInContext(bundle.slice(bridge), page);
    const background = vm.createContext({ ...globals, chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: { session: { get: async () => ({}), set: async () => {} } },
        tabs: { onRemoved: { addListener() {} }, get: async () => ({}), sendMessage: async () => {} },
        scripting: { executeScript: async ({ func, args = [] }) => {
            page.args = args;
            return [{ result: await vm.runInContext(`(${func.toString()})(...args)`, page) }];
        } }
    } });
    vm.runInContext(fs.readFileSync(process.env.BACKGROUND_SCRIPT_PATH || path.join(root, 'background.js'), 'utf8'), background);
    return { window, background };
}
const request = videoId => ({ videoId, tabId: 12, frameId: 0, title: videoId, settings: { streamId: videoId } });

test('out-of-order publish responses cannot resolve another video start', async () => {
    const app = application();
    app.window.publishVideoToVDO = async videoId => {
        await new Promise(resolve => setTimeout(resolve, videoId === 'bad' ? 5 : 25));
        return videoId === 'bad' ? { success: false, error: 'Rejected' } : { success: true };
    };
    const results = await Promise.all(['bad', 'good'].map(id => app.background.startVideoStream(request(id))));
    assert.equal(results[0].success, false);
    assert.equal(results[1].success, true);
});

test('repeated starts create one publisher and a stop waits for its pending start', async () => {
    const app = application();
    let starts = 0, stops = 0;
    app.window.publishVideoToVDO = async () => {
        starts++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true };
    };
    app.window.stopVDOPublisher = async () => { stops++; return { success: true }; };
    const results = await Promise.all([
        app.background.startVideoStream(request('same')),
        app.background.startVideoStream(request('same')),
        app.background.stopVideoStream({ videoId: 'same' })
    ]);
    assert.ok(results.every(result => result.success));
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    assert.equal(vm.runInContext('activePublishers.size', app.background), 0);
});

test('failed stops retain retry controls while simultaneous successful stops are removed', async () => {
    const app = application();
    vm.runInContext(`['bad', 'good'].forEach(id => activePublishers.set(id, { tabId: 12, streamId: id }))`, app.background);
    app.window.stopVDOPublisher = async streamId => {
        await new Promise(resolve => setTimeout(resolve, streamId === 'bad' ? 5 : 25));
        return streamId === 'bad' ? { success: false, error: 'Stop failed' } : { success: true };
    };
    const results = await Promise.all(['bad', 'good'].map(videoId => app.background.stopVideoStream({ videoId })));
    assert.equal(results[0].success, false);
    assert.equal(results[1].success, true);
    assert.equal(vm.runInContext('activePublishers.has("bad")', app.background), true);
    assert.equal(vm.runInContext('activePublishers.has("good")', app.background), false);
});

test('bridge returns thrown publisher errors without waiting for the request timeout', async () => {
    const app = application();
    app.window.publishVideoToVDO = async () => { throw Error('Publisher crashed'); };
    const result = await app.background.startVideoStream(request('bad'));
    assert.equal(result.success, false);
    assert.equal(result.error, 'Publisher crashed');
});

test('a publisher that succeeds after its request times out is stopped instead of orphaned', async () => {
    const app = application({ publishTimeout: 5 });
    const stopped = [];
    app.window.publishVideoToVDO = async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return { success: true };
    };
    app.window.stopVDOPublisher = async streamId => { stopped.push(streamId); return { success: true }; };
    const result = await app.background.startVideoStream(request('late'));
    assert.equal(result.success, false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(stopped, ['late']);
    assert.equal(vm.runInContext('activePublishers.size', app.background), 0);
});

test('different videos cannot overwrite one pending publisher with the same stream ID', async () => {
    const app = application();
    let published = 0;
    app.window.publishVideoToVDO = async () => {
        published++;
        await new Promise(resolve => setTimeout(resolve, 15));
        return { success: true };
    };
    const results = await Promise.all(['one', 'two'].map(id => app.background.startVideoStream({ ...request(id), settings: { streamId: 'same' } })));
    assert.equal(results.filter(result => result.success).length, 1);
    assert.equal(published, 1);
});

test('an already active page publisher cannot be overwritten with a reused stream ID', async () => {
    const app = application();
    const existing = { videoId: 'first' };
    app.window.vdoPublishers = { same: existing };
    app.window.publishVideoToVDO = async () => { assert.fail('Must not overwrite the existing publisher'); };
    const result = await app.background.startVideoStream({ ...request('second'), settings: { streamId: 'same' } });
    assert.equal(result.success, false);
    assert.equal(app.window.vdoPublishers.same, existing);
    assert.match(result.error, /already/i);
});

test('valid stream IDs matching Object prototype names are not mistaken for existing publishers', async () => {
    const app = application();
    app.window.vdoPublishers = {};
    app.window.publishVideoToVDO = async () => ({ success: true });
    for (const streamId of ['constructor', '__proto__', 'toString']) {
        const result = await app.background.startVideoStream({ ...request(streamId), settings: { streamId } });
        assert.equal(result.success, true, `${streamId}: ${result.error}`);
    }
});
