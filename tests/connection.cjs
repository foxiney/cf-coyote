const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ctx = vm.createContext({ Date, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'connection.js'), 'utf8'), ctx);
const Manager = vm.runInContext('CoyoteConnection', ctx);
function fixtures() {
    const held = new Set(), history = [];
    const locks = { request: async (name, _, callback) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({}); } finally { held.delete(name); }
    } };
    const device = () => {
        const listeners = new Map();
        return { gatt: { connected: false, disconnect() { this.connected = false; history.push('disconnect'); } },
            addEventListener: (name, cb) => listeners.set(name, cb),
            removeEventListener: name => listeners.delete(name),
            lose() { this.gatt.connected = false; listeners.get('gattserverdisconnected')?.(); } };
    };
    const manager = (overrides = {}) => new Manager({ locks, onState: state => history.push(state),
        initialize: async device => { device.gatt.connected = true; }, stop: async () => history.push('zero'), ...overrides });
    return { manager, device, history, held };
}
test('connect is disarmed; manual disconnect zeros before closing and releases ownership', async () => {
    const f = fixtures(), m = f.manager(), d = f.device();
    assert.equal(await m.connect(async () => d), true);
    assert.equal(m.armed, false);
    m.arm(); assert.equal(m.armed, true);
    await m.disconnect();
    await new Promise(setImmediate);
    assert.ok(f.history.indexOf('zero') < f.history.indexOf('disconnect'));
    assert.equal(m.armed, false); assert.equal(f.held.size, 0);
    await m.connect(async () => d);
    assert.equal(m.armed, false);
    await m.disconnect();
});
test('second console cannot initialize or disconnect the first console device', async () => {
    const f = fixtures(), first = f.manager();
    await first.connect(async () => f.device()); first.arm();
    let initialized = false;
    const second = f.manager({ initialize: async () => { initialized = true; } });
    assert.equal(await second.connect(async () => f.device()), false);
    assert.equal(initialized, false); assert.equal(first.armed, true);
    assert.equal(first.state, 'connected');
    await first.disconnect();
});
test('unexpected disconnect disarms immediately and permits another console to connect', async () => {
    const f = fixtures(), m = f.manager(), d = f.device();
    await m.connect(async () => d); m.arm(); d.lose();
    assert.equal(m.armed, false); assert.equal(m.state, 'disconnected');
    await new Promise(setImmediate);
    const other = f.manager();
    assert.equal(await other.connect(async () => f.device()), true);
    await other.disconnect();
});
test('cancel during device chooser cannot connect when the old chooser later resolves', async () => {
    const f = fixtures(), m = f.manager(); let choose;
    const pending = m.connect(() => new Promise(resolve => { choose = resolve; }));
    await m.disconnect(); choose(f.device());
    assert.equal(await pending, false); assert.equal(m.device, null); assert.equal(m.armed, false);
});
test('failed initialization frees its lease and does not leave output enabled', async () => {
    const f = fixtures(), m = f.manager({ initialize: async () => { throw new Error('GATT failed'); } });
    assert.equal(await m.connect(async () => f.device()), false);
    assert.equal(m.state, 'error'); assert.equal(m.armed, false);
    await new Promise(setImmediate);
    assert.equal(f.held.size, 0);
});
