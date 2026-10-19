const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function restoration() {
    class Track {
        constructor(kind, id) { this.kind = kind; this.id = id; this.readyState = 'live'; }
        clone() { return new Track(this.kind, this.id + '-clone'); }
        stop() { this.readyState = 'ended'; }
    }
    class MediaStream {
        constructor(tracks) { this.tracks = [...tracks]; }
        getTracks() { return [...this.tracks]; }
        getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
        getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
        addTrack(track) { this.tracks.push(track); }
        removeTrack(track) { this.tracks = this.tracks.filter(t => t !== track); }
    }
    const initial = new Track('video', 'initial');
    const owned = initial.clone();
    const video = { srcObject: new MediaStream([initial]) };
    const rec = { stream: new MediaStream([owned]) };
    let candidate = video;
    const calls = [];
    const vdo = {
        async replaceTrack(oldTrack, track) { calls.push(track); oldTrack.stop(); },
        async addTrack(track) { calls.push(track); },
        async removeTrack(track) { track.stop(); }
    };
    const context = vm.createContext({ window: { vdoPublishers: { stream: rec } },
        streamId: 'stream', videoId: 'selected', baseVideoStream: video.srcObject,
        video, cleaned: false, findDiscordVideo: () => candidate, MediaStream, vdo, debugLog() {} });
    const source = fs.readFileSync(path.join(__dirname, '../combined-vdo-scripts.js'), 'utf8');
    const start = source.indexOf('                const rec = window.vdoPublishers[streamId];', source.indexOf('            // Store\n'));
    const end = source.indexOf('                domObserver.disconnect();', start);
    assert.ok(start > 0 && end > start);
    vm.runInContext(source.slice(start, end) + '\nglobalThis.restore = restoreDiscordSource;', context);
    return { Track, MediaStream, context, rec, vdo, calls, initial,
        candidate(value) { candidate = value; }, restore: () => context.restore() };
}

test('missing Discord source retains publisher without selecting another tile', async () => {
    const app = restoration();
    app.candidate(null);
    await app.restore();
    assert.equal(app.calls.length, 0);
    assert.equal(app.rec.stream.getVideoTracks()[0].id, 'initial-clone');
});

test('Discord track changes publish owned clones and preserve source tracks', async () => {
    const app = restoration();
    const next = new app.Track('video', 'next');
    app.candidate({ srcObject: new app.MediaStream([next]) });
    await app.restore();
    assert.equal(app.calls.length, 1);
    assert.notEqual(app.calls[0], next);
    assert.equal(app.rec.stream.getVideoTracks()[0], app.calls[0]);
    assert.equal(next.readyState, 'live');
    assert.equal(app.initial.readyState, 'live');
    await app.restore();
    assert.equal(app.calls.length, 1);
});

test('stopping during Discord replacement releases the pending owned clone', async () => {
    const app = restoration();
    const next = new app.Track('video', 'next');
    app.candidate({ srcObject: new app.MediaStream([next]) });
    let resolve, replacement;
    app.vdo.replaceTrack = async (_old, track) => {
        replacement = track;
        await new Promise(done => { resolve = done; });
    };
    const pending = app.restore();
    app.context.cleaned = true;
    app.rec.stream.getTracks().forEach(track => track.stop());
    resolve();
    await pending;
    assert.equal(replacement.readyState, 'ended');
    assert.equal(next.readyState, 'live');
});
