const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function captureApp({ sourceObject = false } = {}) {
    class Track {
        constructor(kind) { this.kind = kind; this.readyState = 'live'; }
        stop() { this.readyState = 'ended'; }
        clone() { return new Track(this.kind); }
    }
    class Stream {
        constructor(tracks) { this.tracks = tracks; }
        getTracks() { return this.tracks; }
        getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
        getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
        clone() { return new Stream(this.tracks.map(track => track.clone())); }
    }
    const audio = new Track('audio');
    const source = new Stream(sourceObject ? [new Track('video'), audio] : [audio]);
    const canvasTrack = new Track('video');
    const frames = new Map();
    let draws = 0, nextId = 0;
    const video = { videoWidth: 320, videoHeight: 180, getBoundingClientRect: () => ({ width: 320, height: 180 }),
        ...(sourceObject ? { srcObject: source } : { captureStream: () => source }) };
    const context = vm.createContext({ MediaStream: Stream, console: { error() {} },
        chrome: { runtime: { onMessage: { addListener() {} } } },
        document: { querySelector: () => video, createElement: () => ({
            getContext: () => ({ drawImage() { draws++; } }), captureStream: () => new Stream([canvasTrack])
        }) },
        requestAnimationFrame: callback => { frames.set(++nextId, callback); return nextId; },
        cancelAnimationFrame: id => frames.delete(id)
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8'), context);
    vm.runInContext('getVideoTitle = () => "Test"', context);
    return { context, source, frames, canvasTrack, draws: () => draws };
}

test('canvas fallback starts drawing and reports its added video track', async () => {
    const app = captureApp();
    const result = await app.context.captureVideo('video');
    assert.equal(result.hasVideo, true);
    assert.equal(app.draws(), 1);
    assert.equal(app.frames.size, 1);
    app.context.stopCapture('video');
    assert.equal(app.frames.size, 0);
    assert.equal(app.canvasTrack.readyState, 'ended');
});

test('stopping a srcObject capture preserves the original page stream', async () => {
    const app = captureApp({ sourceObject: true });
    await app.context.captureVideo('video');
    const captured = vm.runInContext('capturedStreams.get("video").stream', app.context);
    app.context.stopCapture('video');
    assert.ok(app.source.getTracks().every(track => track.readyState === 'live'));
    assert.ok(captured.getTracks().every(track => track.readyState === 'ended'));
});

test('repeated capture requests reuse the existing stream and redraw loop', async () => {
    const app = captureApp();
    await app.context.captureVideo('video');
    const first = vm.runInContext('capturedStreams.get("video")', app.context);
    const result = await app.context.captureVideo('video');
    assert.equal(result.hasVideo, true);
    assert.equal(vm.runInContext('capturedStreams.get("video")', app.context), first);
    assert.equal(app.frames.size, 1);
    app.context.stopCapture('video');
});
