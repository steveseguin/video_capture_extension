const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function thumbnail({ stalled = false, audioOnly = false } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../combined-vdo-scripts.js'), 'utf8');
    const begin = source.indexOf('    window.getVDOPublisherThumbnail =');
    const end = source.indexOf('    window.vdoPublisherReady =', begin);
    let paused = 0, cancelled = 0;
    const video = {
        muted: false, srcObject: null, playsInline: false,
        play: async () => {}, pause() { paused++; },
        addEventListener() {}, removeEventListener() {},
        requestVideoFrameCallback(callback) { if (!stalled) queueMicrotask(callback); return 1; },
        cancelVideoFrameCallback() { cancelled++; }
    };
    const window = { vdoPublishers: { stream: { stream: {
        getVideoTracks: () => audioOnly ? [] : [{ readyState: 'live' }]
    } } } };
    vm.runInNewContext(source.slice(begin, end), {
        window, document: { createElement: tag => tag === 'video' ? video : {
            getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,frame'
        } }, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimeout
    });
    return { run: () => window.getVDOPublisherThumbnail('stream'), video, counts: () => ({ paused, cancelled }) };
}

test('publisher thumbnails release the temporary playing video after success', async () => {
    const app = thumbnail();
    assert.equal((await app.run()).success, true);
    assert.equal(app.video.srcObject, null);
    assert.equal(app.counts().paused, 1);
});

test('publisher thumbnails finish and release resources when no video frame arrives', async () => {
    const app = thumbnail({ stalled: true });
    const result = await Promise.race([app.run(), new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
    assert.notEqual(result, 'hung');
    assert.equal(result.success, false);
    assert.equal(app.video.srcObject, null);
    assert.equal(app.counts().cancelled, 1);
});

test('audio-only publisher thumbnails fail without waiting for a video frame', async () => {
    const app = thumbnail({ stalled: true, audioOnly: true });
    const result = await Promise.race([app.run(), new Promise(resolve => setTimeout(() => resolve('hung'), 100))]);
    assert.notEqual(result, 'hung');
    assert.equal(result.success, false);
});
