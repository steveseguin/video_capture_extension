const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function popup() {
    const list = { children: [], html: '', set innerHTML(value) { this.html = value; this.children = []; },
        appendChild(child) { this.children.push(child); } };
    const context = vm.createContext({ console: { error() {} }, document: {
        addEventListener() {}, getElementById: () => list
    }, chrome: { scripting: {}, tabs: {}, runtime: {} } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8'), context);
    vm.runInContext(`currentTab = { id: 12, url: 'https://example.test' };
        createVideoElement = video => video.id;
        saveActiveStreams = () => {};
        refreshThumbnails = () => {};`, context);
    return { context, list };
}
const videos = id => [{ frameId: 0, result: [{ id }] }];

test('a slow older scan cannot replace a newer video list', async () => {
    const app = popup();
    const first = deferred();
    let calls = 0;
    app.context.chrome.scripting.executeScript = () => ++calls === 1 ? first.promise : Promise.resolve(videos('new'));
    app.context.chrome.tabs.sendMessage = async () => null;
    const older = app.context.refreshVideos();
    await app.context.refreshVideos();
    first.resolve(videos('old'));
    await older;
    assert.deepEqual(app.list.children, ['new']);
});

test('late screenshots from an old scan cannot append stale video cards', async () => {
    const app = popup();
    const screenshot = deferred();
    const requested = deferred();
    let scans = 0;
    app.context.chrome.scripting.executeScript = async () => videos(++scans === 1 ? 'old' : 'new');
    app.context.chrome.tabs.sendMessage = (tabId, message) => {
        if (message.videoId === 'old') { requested.resolve(); return screenshot.promise; }
        return Promise.resolve(null);
    };
    const older = app.context.refreshVideos();
    await requested.promise;
    await app.context.refreshVideos();
    screenshot.resolve(null);
    await older;
    assert.deepEqual(app.list.children, ['new']);
});

test('an outdated scan error cannot replace a newer successful result', async () => {
    const app = popup();
    const first = deferred();
    let calls = 0;
    app.context.chrome.scripting.executeScript = () => ++calls === 1 ? first.promise : Promise.resolve(videos('new'));
    app.context.chrome.tabs.sendMessage = async () => null;
    const older = app.context.refreshVideos();
    await app.context.refreshVideos();
    first.reject(Error('Old scan failed'));
    await older;
    assert.deepEqual(app.list.children, ['new']);
});

test('out-of-order background snapshots cannot restore stale stream controls', async () => {
    const app = popup();
    const first = deferred();
    let calls = 0;
    app.context.chrome.runtime.sendMessage = () => ++calls === 1 ? first.promise : Promise.resolve([{ id: 'new', streamId: 'new' }]);
    const older = app.context.syncWithBackground();
    await app.context.syncWithBackground();
    first.resolve([{ id: 'old', streamId: 'old' }]);
    await older;
    assert.equal(vm.runInContext('activeStreams.has("new") && !activeStreams.has("old")', app.context), true);
});
