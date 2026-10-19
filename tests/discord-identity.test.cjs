const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function discordApp() {
    let sequence = 0;
    class MediaStream {
        constructor(id, track) { this.id = id; this.track = { id: track }; }
        getVideoTracks() { return [this.track]; }
    }
    const videos = [];
    const body = {};
    const context = vm.createContext({ MediaStream, URL, console,
        crypto: { randomUUID: () => String(++sequence) },
        window: { location: { hostname: 'discord.com', pathname: '/channels/server/call' } },
        document: { body, querySelectorAll: () => videos },
        chrome: { runtime: { onMessage: { addListener() {} } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8'), context);
    function video(name, owner, streamId, trackId) {
        const element = { dataset: {}, isConnected: true, parentElement: body,
            srcObject: new MediaStream(streamId, trackId), name, owner,
            getAttribute: key => key === 'aria-label' ? element.name : null,
            querySelectorAll: () => [],
            closest: () => element.owner ? { getAttribute: () => element.owner } : null,
            querySelector: () => null
        };
        return element;
    }
    return { videos, video, MediaStream, update: () => context.updateDiscordVideoIds(videos),
        find: id => context.findDiscordVideo(id) };
}

test('recycled tile cannot retain a participant ID using a stale owner', () => {
    const app = discordApp();
    const tile = app.video('Call tile, Alice', 'alice', 'alice-stream', 'alice-track');
    app.videos.push(tile);
    app.update();
    const aliceId = tile.dataset.vdoCaptureId;
    // Discord reuses a video node for another tile before its avatar/user ID renders.
    tile.name = 'Call tile, Bob';
    tile.owner = '';
    tile.srcObject = new app.MediaStream('bob-stream', 'bob-track');
    app.update();
    assert.notEqual(tile.dataset.vdoCaptureId, aliceId);
    assert.equal(app.find(aliceId), null);
});

test('tile reorder and rebuilt elements retain IDs through media identity', () => {
    const app = discordApp();
    const alice = app.video('Call tile, Alice', 'alice', 'alice-stream', 'alice-track');
    const bob = app.video('Call tile, Bob', 'bob', 'bob-stream', 'bob-track');
    app.videos.push(alice, bob);
    app.update();
    const id = alice.dataset.vdoCaptureId;
    const rebuilt = app.video('Call tile, Alice', '', 'alice-stream', 'alice-track');
    app.videos.splice(0, 2, bob, rebuilt);
    alice.isConnected = false;
    app.update();
    assert.equal(rebuilt.dataset.vdoCaptureId, id);
    assert.equal(app.find(id), rebuilt);
});

test('verified owner preserves ID through track and display-name changes', () => {
    const app = discordApp();
    const tile = app.video('Call tile, Alice', 'alice', 'old-stream', 'old-track');
    app.videos.push(tile);
    app.update();
    const id = tile.dataset.vdoCaptureId;
    tile.name = 'Call tile, Alice renamed';
    tile.srcObject = new app.MediaStream('new-stream', 'new-track');
    app.update();
    assert.equal(tile.dataset.vdoCaptureId, id);
});

test('ambiguous display names cannot select a detached participant by tile order', () => {
    const app = discordApp();
    const first = app.video('Call tile, Same Name', '', 'first-stream', 'first-track');
    const second = app.video('Call tile, Same Name', '', 'second-stream', 'second-track');
    app.videos.push(first, second);
    app.update();
    const firstId = first.dataset.vdoCaptureId;
    const secondId = second.dataset.vdoCaptureId;
    assert.notEqual(firstId, secondId);
    const unknown = app.video('Call tile, Same Name', '', 'unknown-stream', 'unknown-track');
    app.videos.splice(0, 2, unknown);
    first.isConnected = second.isConnected = false;
    app.update();
    assert.notEqual(unknown.dataset.vdoCaptureId, firstId);
    assert.notEqual(unknown.dataset.vdoCaptureId, secondId);
    assert.equal(app.find(firstId), null);
});

test('missing camera returns by verified owner without selecting that owner’s screen', () => {
    const app = discordApp();
    const camera = app.video('Call tile, Alice', 'alice', 'camera-stream', 'camera-track');
    const screen = app.video('Call tile, Alice, stream', 'alice', 'screen-stream', 'screen-track');
    app.videos.push(camera, screen);
    app.update();
    const cameraId = camera.dataset.vdoCaptureId;
    app.videos.splice(0, 1);
    camera.isConnected = false;
    assert.equal(app.find(cameraId), null);
    const returning = app.video('Call tile, Alice', 'alice', 'return-stream', 'return-track');
    app.videos.push(returning);
    app.update();
    assert.equal(app.find(cameraId), returning);
    assert.notEqual(screen.dataset.vdoCaptureId, cameraId);
});
