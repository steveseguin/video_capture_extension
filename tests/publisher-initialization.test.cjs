const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('the bundled SDK makes publisher functions available immediately without a polling delay', () => {
    const source = fs.readFileSync(path.join(__dirname, '../combined-vdo-scripts.js'), 'utf8');
    const window = new EventTarget();
    let polls = 0;
    vm.runInNewContext(source.slice(source.indexOf('// Setting up VDO publisher functions...')), {
        window, VDONinjaSDK: function() {}, console,
        setInterval() { polls++; }, clearInterval() {}
    });
    assert.equal(typeof window.publishVideoToVDO, 'function');
    assert.equal(window.vdoFullyLoaded, true);
    assert.equal(polls, 0);
    assert.equal(Object.getPrototypeOf(window.vdoPublishers), null);
});

test('publisher initialization still waits when the SDK is loaded separately', () => {
    const source = fs.readFileSync(path.join(__dirname, '../combined-vdo-scripts.js'), 'utf8');
    let poll, cleared = false;
    const context = vm.createContext({ window: new EventTarget(), console,
        setInterval(callback) { poll = callback; return 1; }, clearInterval() { cleared = true; } });
    vm.runInContext(source.slice(source.indexOf('// Setting up VDO publisher functions...')), context);
    assert.equal(context.window.publishVideoToVDO, undefined);
    context.VDONinjaSDK = function() {};
    poll();
    assert.equal(typeof context.window.publishVideoToVDO, 'function');
    assert.equal(cleared, true);
});
