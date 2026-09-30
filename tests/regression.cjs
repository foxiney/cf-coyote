const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(file, { emitStorageChanges = false } = {}) {
    const storage = { automation: { simulation: false }, cfg: { strength: 20, comboStep: 5, cdSeconds: 0 } }, elements = new Map(), writes = [];
    const listeners = [];
    const intervals = [];
    const alarms = new Map(), alarmCreates = [], messageListeners = [];
    let submissions = [], apiFailure = false;
    const heldLocks = new Set();
    const get = async (keys, callback) => {
        const result = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]]));
        if (callback) queueMicrotask(() => callback(result));
        return result;
    };
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: id === 'strengthSlider' ? '20' : '0', checked: id === 'chanA', style: { setProperty() {} },
            classList: { add() {}, remove() {}, toggle() {} }, children: [],
            setAttribute() {},
            replaceChildren() { this.children = []; this.textContent = ''; },
            append(...items) { this.children.push(...items); }, prepend(item) { this.children.unshift(item); },
        });
        return elements.get(id);
    };
    const context = vm.createContext({
        console, URLSearchParams, AbortSignal, Uint8Array, Date, importScripts() {},
        setTimeout: (callback, ms) => { if (ms >= 3000) return setTimeout(callback, ms); queueMicrotask(callback); return 1; }, clearTimeout,
        setInterval(callback) { intervals.push(callback); },
        window: { addEventListener() {} }, alert() {},
        document: { getElementById: element, querySelectorAll: () => [],
            documentElement: element('root'), createElement: () => element(Symbol()), addEventListener() {} },
        navigator: { locks: { request: async (name, _options, callback) => {
            if (heldLocks.has(name)) return callback(null);
            heldLocks.add(name);
            try { return await callback({}); } finally { heldLocks.delete(name); }
        } } },
        chrome: {
            storage: { local: { get, set: async data => {
                const changes = {};
                for (const [key, value] of Object.entries(data)) {
                    if (JSON.stringify(storage[key]) !== JSON.stringify(value)) {
                        changes[key] = { oldValue: structuredClone(storage[key]), newValue: structuredClone(value) };
                    }
                }
                Object.assign(storage, structuredClone(data));
                if (emitStorageChanges && Object.keys(changes).length) queueMicrotask(() => {
                    for (const listener of listeners) listener(changes, 'local');
                });
            },
                remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(key => delete storage[key]) },
                onChanged: { addListener(fn) { listeners.push(fn); } } },
            runtime: { getURL: file => `chrome-extension://test/${file}`,
                onMessage: { addListener(fn) { messageListeners.push(fn); } }, sendMessage: async request => {
                    if (request.action === 'SET_CFG') await context.chrome.storage.local.set({ cfg: { ...storage.cfg, ...request.value } });
                    return { ok: true, result: { status: 'OK', result: [] } };
                } },
            action: { onClicked: { addListener() {} } },
            alarms: { get: async name => alarms.get(name), clear: async name => alarms.delete(name),
                create: async (name, info) => { alarmCreates.push(name); alarms.set(name, { name, ...info }); },
                onAlarm: { addListener() {} } },
        },
        fetch: async url => {
            if (apiFailure) throw new Error('offline');
            return { ok: true, json: async () => ({ status: 'OK', result: url.includes('user.info') ? [{ handle: 'Alice' }] : submissions }) };
        },
        fakeConnection: { writeValue: async packet => { writes.push(Array.from(packet)); } },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8'), context);
    if (file === 'control.js') {
        for (const script of ['features.js', 'connection.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', script), 'utf8'), context);
    }
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    return { storage, writes, context, listeners, element, intervals, heldLocks, alarms, alarmCreates,
        message: request => new Promise(resolve => messageListeners[0](request, { url: 'https://codeforces.com/' }, resolve)),
        run: code => vm.runInContext(code, context),
        submissions: value => { submissions = value; }, fail: (value = true) => { apiFailure = value; } };
}

test('account validation establishes a baseline, clears old state, ignores historical failures', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { comboCount: 9, zapSeq: 12, pendingSubs: ['99'] });
    h.submissions([{ id: 100, verdict: 'WRONG_ANSWER' }]);
    await h.run("setAccount(' Alice ')");
    assert.equal(h.storage.cfHandle, 'Alice');
    assert.equal(h.storage.comboCount, 0);
    assert.equal(h.storage.zapAck, 12);
    await h.run('pollAccount()');
    assert.equal(h.storage.zapSeq, 12);
    assert.equal(h.storage.pendingSubs, undefined);
    await assert.rejects(h.run("setAccount('x;bad')"));
});

test('pending verdicts finish once, repeated polls deduplicate, AC resets combo', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] }, comboCount: 0 });
    h.submissions([{ id: 101, verdict: 'TESTING' }]);
    await h.run('pollAccount()');
    assert.deepEqual(h.storage.monitor.pending, [101]);
    h.submissions([{ id: 102, verdict: 'WRONG_ANSWER' }, { id: 101, verdict: 'TIME_LIMIT_EXCEEDED' }]);
    await h.run('lastPollAt = 0; pollAccount()');
    assert.equal(h.storage.comboCount, 2);
    assert.equal(h.storage.zapSeq, 1);
    await h.run('lastPollAt = 0; pollAccount()');
    assert.equal(h.storage.zapSeq, 1);
    h.submissions([{ id: 103, verdict: 'OK' }]);
    await h.run('lastPollAt = 0; pollAccount()');
    assert.equal(h.storage.comboCount, 0);
    assert.ok(h.storage.lastAcTs);
});

test('failed requests preserve monitor progress and expose an error', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [101] } });
    h.fail();
    await assert.rejects(h.run('pollAccount()'));
    assert.deepEqual(h.storage.monitor, { cursor: 100, pending: [101] });
    assert.equal(h.storage.monitorError, 'offline');
});

test('panic suppresses background failure events while still recording verdicts', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] }, panicUntil: Date.now() + 10000 });
    h.submissions([{ id: 101, verdict: 'WRONG_ANSWER' }]);
    await h.run('pollAccount()');
    assert.equal(h.storage.comboCount, 1);
    assert.equal(h.storage.zapSeq, undefined);
});

test('V3 packets use absolute intensity, correct size and clamped channels', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    const packet = Array.from(h.run('buildPacket(999, -5, true, true)'));
    assert.equal(packet.length, 20);
    assert.deepEqual(packet.slice(0, 4), [0xB0, 0x0F, 100, 0]);
    assert.deepEqual(Array.from(h.run('buildPacket(50, 50, false, false)')).slice(2, 4), [0, 0]);
});

test('panic interrupts the active loop: no later nonzero packets', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    h.context.stopNow = () => h.run('panicUntil = Date.now() + 10000; cancelOutput()');
    h.context.fakeConnection.writeValue = async packet => {
        h.writes.push(Array.from(packet));
        if (packet[2] > 0) h.context.stopNow();
    };
    await h.run('connectionManager.armed = true; char = fakeConnection; executeZap(20)');
    assert.equal(h.writes.filter(p => p[2] > 0).length, 1);
    assert.deepEqual(h.writes.at(-1).slice(2, 4), [0, 0]);
});

test('V3 connection initializes soft limits and zero output before enabling notifications', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    let notified = false;
    const service = { getCharacteristic: async uuid => uuid.includes('150a')
        ? h.context.fakeConnection : { addEventListener() {}, startNotifications: async () => { notified = true; } } };
    h.context.device = { gatt: { connected: true, disconnect() {}, connect: async () => ({ disconnect() {}, getPrimaryService: async () => service }) }, addEventListener() {}, removeEventListener() {} };
    await h.run('connectionManager.connect(async () => device)');
    assert.deepEqual(h.writes[0], [0xBF, 100, 100, 0, 0, 0, 0]);
    assert.deepEqual(h.writes[1].slice(0, 4), [0xB0, 0x0F, 0, 0]);
    assert.equal(notified, true);
    assert.equal(h.run('bleState'), 'connected');
});

test('manual trigger respects persisted panic and stale automatic events are discarded', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    h.run('connectionManager.armed = true; char = fakeConnection');
    h.storage.panicUntil = Date.now() + 10000;
    await h.run('handleZap(true)');
    assert.equal(h.writes.length, 0);
    Object.assign(h.storage, { panicUntil: 0, cfHandle: 'Alice', zapSeq: 2, zapAck: 1,
        zapInfo: { handle: 'Alice', ts: Date.now() - 60000 } });
    await h.run('handleZap()');
    assert.equal(h.storage.zapAck, 2);
    assert.equal(h.writes.length, 0);
});

test('simultaneous signal consumers output only once and persist acknowledgement', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    h.run('connectionManager.armed = true; char = fakeConnection');
    Object.assign(h.storage, { cfHandle: 'Alice', zapSeq: 3, zapAck: 2,
        zapInfo: { handle: 'Alice', ts: Date.now(), combo: 1 } });
    await Promise.all([h.run('handleZap()'), h.run('handleZap()')]);
    assert.equal(h.storage.zapAck, 3);
    assert.equal(h.writes.filter(p => p[2] > 0).length, 15);
    await h.run('handleZap()');
    assert.equal(h.writes.filter(p => p[2] > 0).length, 15);
});

test('simulation is the default and records a predicted power without creating an output event', async () => {
    const h = harness('background.js');
    delete h.storage.automation;
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] } });
    h.submissions([{ id: 101, verdict: 'WRONG_ANSWER' }]);
    await h.run('pollAccount()');
    assert.equal(h.storage.zapSeq, undefined);
    assert.equal(h.storage.eventLog[0].status, 'simulated');
    assert.equal(h.storage.eventLog[0].power, 20);
    assert.equal(h.storage.zapStats, undefined);
});

test('WA and TLE have separate actions and powers; ignored failures do not increment combo', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] },
        automation: { simulation: true, rules: {
            WRONG_ANSWER: { action: 'ignore' }, COMPILATION_ERROR: { action: 'log' },
            TIME_LIMIT_EXCEEDED: { action: 'output', power: 30 }
        } } });
    h.submissions([{ id: 101, verdict: 'WRONG_ANSWER' }, { id: 102, verdict: 'COMPILATION_ERROR' },
        { id: 103, verdict: 'TIME_LIMIT_EXCEEDED' }]);
    await h.run('pollAccount()');
    assert.equal(h.storage.comboCount, 2);
    assert.deepEqual(h.storage.eventLog.map(e => e.status), ['simulated', 'log', 'ignored']);
    assert.equal(h.storage.eventLog[0].power, 35);
    assert.equal(h.storage.zapSeq, undefined);
});

test('simulated and real cooldown clocks are independent', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { cfg: { strength: 20, cdSeconds: 60 }, automation: { simulation: true } });
    await h.run("dispatchEvent({ verdictCode: 'WRONG_ANSWER', combo: 1 })");
    await h.run("dispatchEvent({ verdictCode: 'TIME_LIMIT_EXCEEDED', combo: 1 })");
    assert.equal(h.storage.eventLog[0].status, 'skipped');
    assert.match(h.storage.eventLog[0].reason, /冷却剩余/);
    h.storage.automation.simulation = false;
    await h.run("dispatchEvent({ verdictCode: 'WRONG_ANSWER', combo: 1 })");
    assert.equal(h.storage.zapSeq, 1);
});

test('practice restricts both contest and submission time, including AC combo resets', async () => {
    const h = harness('background.js');
    const start = Date.now() - 10000;
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] }, comboCount: 4,
        automation: { simulation: true }, practice: { enabled: true, active: true, contestId: 2000, startedAt: start, endsAt: Date.now() + 60000 } });
    h.submissions([
        { id: 101, contestId: 2001, creationTimeSeconds: Date.now() / 1000, verdict: 'OK' },
        { id: 102, contestId: 2000, creationTimeSeconds: (start - 1000) / 1000, verdict: 'WRONG_ANSWER' },
        { id: 103, contestId: 2000, creationTimeSeconds: Date.now() / 1000, verdict: 'TIME_LIMIT_EXCEEDED' }
    ]);
    await h.run('pollAccount()');
    assert.equal(h.storage.comboCount, 5);
    assert.equal(h.storage.eventLog.length, 1);
    assert.equal(h.storage.eventLog[0].subId, '103');
});

test('starting a practice establishes a fresh baseline and rejects invalid duration', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 0, pending: [1] }, zapSeq: 9 });
    h.submissions([{ id: 123 }]);
    await assert.rejects(h.run("setPractice({ mode: 'start', contestId: 2000, minutes: 0 })"));
    await h.run("setPractice({ mode: 'start', contestId: 2000, minutes: 60 })");
    assert.equal(h.storage.monitor.cursor, 123);
    assert.deepEqual(h.storage.monitor.pending, []);
    assert.equal(h.storage.practice.contestId, 2000);
    assert.equal(h.storage.practice.endsAt - h.storage.practice.startedAt, 3600000);
    assert.equal(h.storage.zapAck, 9);
});

test('expired practice stays stopped, cancels queued output and suppresses idle triggers', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { cfHandle: 'Alice', zapSeq: 4, zapInfo: { old: true },
        cfg: { idleEnabled: true, idleMinutes: 5 }, lastAcTs: Date.now() - 600000,
        practice: { enabled: true, active: true, endsAt: Date.now() - 1 } });
    await h.run('expirePractice();');
    await h.run('idleTick()');
    assert.equal(h.storage.practice.active, false);
    assert.equal(h.storage.practice.enabled, true);
    assert.equal(h.storage.zapInfo, null);
    assert.equal(h.storage.zapAck, 4);
    assert.equal(h.storage.zapSeq, 4);
});

test('rule changes acknowledge pending events and increment policy revision', async () => {
    const h = harness('background.js');
    Object.assign(h.storage, { zapSeq: 5, zapInfo: { old: true }, policyRevision: 7 });
    await h.run("setAutomation({ simulation: true, rules: { WRONG_ANSWER: { action: 'output', power: 999 } } })");
    assert.equal(h.storage.zapAck, 5);
    assert.equal(h.storage.zapInfo, null);
    assert.equal(h.storage.policyRevision, 8);
    assert.equal(h.storage.automation.rules.WRONG_ANSWER.power, 100);
});

test('simulation test remains non-output even when the global mode is real', async () => {
    const h = harness('background.js');
    await h.run("simulateVerdict('WRONG_ANSWER')");
    assert.equal(h.storage.eventLog[0].status, 'simulated');
    assert.equal(h.storage.zapSeq, undefined);
    assert.equal(h.storage.comboCount, undefined);
});

test('event history is bounded and executed acknowledgements count once', async () => {
    const h = harness('background.js');
    for (let i = 0; i < 105; i++) await h.run(`appendLog({ id: '${i}', status: 'log' })`);
    assert.equal(h.storage.eventLog.length, 100);
    await h.run("recordOutput({ id: 'output', status: 'executed' })");
    await h.run("recordOutput({ id: 'output', status: 'executed' })");
    assert.equal(h.storage.zapStats.count, 1);
});

test('simulation blocks direct output even with a connected device', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    h.storage.automation.simulation = true;
    await h.run('simulationMode = true; connectionManager.armed = true; char = fakeConnection; executeZap(20)');
    await h.run('handleZap(true)');
    assert.equal(h.writes.length, 0);
});

test('battery read and notifications update percentage, and missing service is nonfatal', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    let changed;
    const data = number => new DataView(Uint8Array.of(number).buffer);
    h.context.batteryServer = { getPrimaryService: async uuid => {
        assert.ok(uuid.includes('180a'));
        return { getCharacteristic: async uuid => {
            assert.ok(uuid.includes('1500'));
            return { readValue: async () => data(81), addEventListener: (_name, callback) => { changed = callback; }, startNotifications: async () => {} };
        } };
    } };
    await h.run('connectBattery(batteryServer)');
    assert.match(h.element('batteryLevel').textContent, /电量：81%.*更新/);
    changed({ target: { value: data(15) } });
    assert.match(h.element('batteryLevel').textContent, /15%.*偏低/);
    changed({ target: { value: data(255) } });
    assert.match(h.element('batteryLevel').textContent, /不可用/);
    h.context.batteryServer.getPrimaryService = async () => { throw new Error('unsupported'); };
    await h.run('connectBattery(batteryServer)');
    assert.match(h.element('batteryLevel').textContent, /不可用/);
});

test('switching to simulation cancels the remaining nonzero packets immediately', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    h.context.switchMode = () => {
        for (const listener of h.listeners) listener({ automation: { newValue: { simulation: true } } }, 'local');
    };
    h.context.fakeConnection.writeValue = async packet => {
        h.writes.push(Array.from(packet));
        if (packet[2] > 0) h.context.switchMode();
    };
    await h.run('connectionManager.armed = true; char = fakeConnection; executeZap(20)');
    assert.equal(h.writes.filter(p => p[2] > 0).length, 1);
    assert.equal(h.writes.at(-1)[2], 0);
});

test('session expiry during active output stops the next packet without waiting for an alarm', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    h.run('currentPractice = { enabled: true, active: true, startedAt: 1, endsAt: Date.now() + 10000 }');
    h.context.expire = () => h.run('currentPractice.endsAt = Date.now() - 1');
    h.context.fakeConnection.writeValue = async packet => {
        h.writes.push(Array.from(packet));
        if (packet[2] > 0) h.context.expire();
    };
    await h.run('connectionManager.armed = true; char = fakeConnection; executeZap(20)');
    assert.equal(h.writes.filter(p => p[2] > 0).length, 1);
    assert.equal(h.writes.at(-1)[2], 0);
});

test('old policy revisions never execute after a rule change', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    Object.assign(h.storage, { cfHandle: 'Alice', zapSeq: 3, zapAck: 2, policyRevision: 8,
        zapInfo: { handle: 'Alice', ts: Date.now(), combo: 1, policyRevision: 7 } });
    h.run('connectionManager.armed = true; char = fakeConnection');
    await h.run('handleZap()');
    assert.equal(h.writes.length, 0);
});

test('the console references valid local scripts and has no duplicate element ids', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'control.html'), 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', match[1])));
    }
    for (const file of ['control.js', 'features.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        for (const match of source.matchAll(/getElementById\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), match[1]);
    }
});

test('connected but unarmed console refuses direct and manual output', async () => {
    const h = harness('control.js');
    await new Promise(resolve => setImmediate(resolve));
    h.run('char = fakeConnection');
    assert.equal(h.run('connectionManager.armed'), false);
    await h.run('executeZap(20)');
    await h.run('handleZap(true)');
    assert.equal(h.writes.length, 0);
});

for (const change of ['channel', 'strength', 'remote']) {
    test(`changing ${change} settings interrupts active output and disarms`, async () => {
        const h = harness('control.js', { emitStorageChanges: true });
        await new Promise(setImmediate);
        h.context.fakeConnection.writeValue = async packet => {
            h.writes.push(Array.from(packet));
            if (h.writes.length !== 1) return;
            if (change === 'channel') {
                h.element('chanA').checked = false;
                h.element('chanA').onchange();
            } else if (change === 'strength') {
                h.element('strengthSlider').value = '5';
                h.element('strengthSlider').oninput();
            } else {
                await h.run('chrome.storage.local.set({ cfg: { strength: 5, useA: false, useB: false } })');
            }
        };
        await h.run('connectionManager.armed = true; char = fakeConnection; executeZap(20)');
        assert.equal(h.writes.filter(p => p[2] > 0).length, 1);
        assert.deepEqual(h.writes.at(-1).slice(2, 4), [0, 0]);
        assert.equal(h.run('connectionManager.armed'), false);
        if (change === 'remote') {
            assert.equal(h.element('chanA').checked, false);
            assert.equal(h.element('chanB').checked, false);
            assert.equal(Number(h.element('strengthSlider').value), 5);
        }
    });
}

test('hung write times out, disconnects, releases output lock and permits a fresh connection', async () => {
    const h = harness('control.js');
    await new Promise(setImmediate);
    let disconnected = 0, finishOldWrite;
    h.context.fakeConnection.writeValue = () => new Promise(resolve => { finishOldWrite = resolve; });
    h.context.device = { gatt: { connected: true, disconnect() { disconnected++; this.connected = false; } }, removeEventListener() {} };
    await assert.rejects(h.run('connectionManager.device = device; connectionManager.state = "connected"; connectionManager.armed = true; char = fakeConnection; handleZap(true)'), /蓝牙写入超时/);
    await new Promise(setImmediate);
    assert.equal(disconnected, 1);
    assert.equal(h.run('connectionManager.armed'), false);
    assert.equal(h.heldLocks.has('coyote-output'), false);
    assert.equal(h.run('char'), null);
    h.context.freshConnection = { writeValue: async packet => h.writes.push(Array.from(packet)) };
    h.context.freshDevice = { gatt: { connected: true, disconnect() {} }, addEventListener() {}, removeEventListener() {} };
    await h.run('connectionManager.initialize = async () => { char = freshConnection; }; connectionManager.connect(async () => freshDevice)');
    assert.equal(h.run('connectionManager.armed'), false);
    await h.run('connectionManager.arm(); handleZap(true)');
    assert.equal(h.writes.filter(p => p[2] > 0).length, 15);
    const count = h.writes.length;
    finishOldWrite();
    await new Promise(setImmediate);
    assert.equal(h.writes.length, count);
    assert.equal(h.run('connectionManager.state'), 'connected');
    await h.run('connectionManager.disconnect()');
});

test('failed page poll followed by a throttled alarm cannot create an idle event; successful recovery can', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    const anchor = Date.now() - 600000;
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] },
        cfg: { idleEnabled: true, idleMinutes: 5, cdSeconds: 0 }, lastAcTs: anchor,
        lastPollTs: Date.now() });
    h.fail();
    await assert.rejects(h.run('pollAccount()'), /offline/);
    assert.equal(await h.run('pollAccount()'), 'throttled');
    await h.run('idleTick()');
    assert.equal(h.storage.zapSeq, undefined);
    assert.equal(h.storage.lastAcTs, anchor);
    h.fail(false);
    assert.equal(await h.run('lastPollAt = 0; pollAccount()'), 'success');
    await h.run('idleTick()');
    assert.equal(h.storage.zapSeq, 1);
    assert.match(h.storage.zapInfo.verdict, /无 AC/);
});

test('manual disconnect during a hung output settles both tasks without leaving a lock or queued writes', async () => {
    const h = harness('control.js');
    await new Promise(setImmediate);
    let started;
    const writing = new Promise(resolve => { started = resolve; });
    h.context.fakeConnection.writeValue = () => { started(); return new Promise(() => {}); };
    h.context.device = { gatt: { connected: true, disconnect() { this.connected = false; } }, removeEventListener() {} };
    const output = h.run('connectionManager.device = device; connectionManager.state = "connected"; connectionManager.armed = true; char = fakeConnection; handleZap(true)');
    const rejected = assert.rejects(output, /蓝牙写入超时/);
    await writing;
    await h.run('connectionManager.disconnect()');
    await rejected;
    assert.equal(h.run('connectionManager.state'), 'disconnected');
    assert.equal(h.run('connectionManager.disconnectTask'), null);
    assert.equal(h.heldLocks.has('coyote-output'), false);
    h.run('char = fakeConnection');
    h.context.fakeConnection.writeValue = async packet => h.writes.push(Array.from(packet));
    await h.run('writePacket(fakeConnection, buildPacket(0, 0, false, false))');
    assert.equal(h.writes.length, 1);
});

test('idle decisions reject stale or missing sync data but accept a recently successful throttled poll', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] },
        cfg: { idleEnabled: true, idleMinutes: 5, cdSeconds: 0 }, lastAcTs: Date.now() - 600000 });
    await h.run('idleTick()');
    assert.equal(h.storage.zapSeq, undefined);
    h.storage.lastPollTs = Date.now() - 16000;
    await h.run('idleTick()');
    assert.equal(h.storage.zapSeq, undefined);
    await h.run('pollAccount()');
    assert.equal(await h.run('pollAccount()'), 'throttled');
    await h.run('idleTick()');
    assert.equal(h.storage.zapSeq, 1);
});

test('pending log rows expire on a timer without storage events and clearing discards old rows', async () => {
    const h = harness('control.js');
    await new Promise(setImmediate);
    h.run('globalThis.logEntry = { status: "pending", ts: Date.now(), verdict: "WA" }; renderEventLog([logEntry])');
    const row = h.element('zapLog').children[0];
    assert.match(row.textContent, /待处理/);
    h.run('logEntry.ts -= 16000');
    for (const tick of h.intervals) tick();
    assert.match(row.textContent, /已过期/);
    h.run('renderEventLog([])');
    assert.equal(h.run('pendingLogRows.length'), 0);
    assert.equal(h.element('zapLog').children.length, 0);
});

test('page monitoring triggers one-minute idle at expiry without waiting for an alarm', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] },
        automation: { simulation: true }, cfg: { idleEnabled: true, idleMinutes: 1, cdSeconds: 0 },
        lastAcTs: Date.now() - 59000 });
    assert.equal((await h.message({ action: 'POLL_ACCOUNT' })).ok, true);
    assert.equal(h.storage.eventLog, undefined);
    h.storage.lastAcTs = Date.now() - 61000;
    h.storage.idleStartedAt = h.storage.lastAcTs;
    h.storage.idleNextAt = Date.now() - 1000;
    assert.equal((await h.message({ action: 'POLL_ACCOUNT' })).ok, true);
    assert.equal(h.storage.eventLog.length, 1);
    assert.equal(h.storage.eventLog[0].verdict, '无 AC 到期（1 分钟）');
    assert.equal(h.storage.eventLog[0].status, 'simulated');
    await h.message({ action: 'POLL_ACCOUNT' });
    assert.equal(h.storage.eventLog.length, 1);
});

test('integrated monitoring keeps idle blocked on API failure and resets its timer for a new AC', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    const anchor = Date.now() - 61000;
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] },
        cfg: { idleEnabled: true, idleMinutes: 1 }, lastAcTs: anchor });
    h.fail();
    assert.equal((await h.message({ action: 'POLL_ACCOUNT' })).ok, false);
    await h.message({ action: 'POLL_ACCOUNT' });
    assert.equal(h.storage.zapSeq, undefined);
    assert.equal(h.storage.lastAcTs, anchor);
    h.fail(false);
    h.submissions([{ id: 101, verdict: 'OK' }]);
    h.run('lastPollAt = 0');
    await h.message({ action: 'POLL_ACCOUNT' });
    assert.equal(h.storage.zapSeq, undefined);
    assert.ok(h.storage.lastAcTs > anchor);
    assert.equal(h.storage.eventLog[0].status, 'accepted');
});

test('worker initialization preserves an existing polling alarm and recreates a missing one', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] } });
    const scheduled = { name: 'pollAccount', scheduledTime: Date.now() + 5000, periodInMinutes: 1 };
    h.alarms.set('pollAccount', scheduled);
    await h.run('initialize()');
    await h.run('initialize()');
    assert.equal(h.alarms.get('pollAccount'), scheduled);
    assert.equal(h.alarmCreates.filter(name => name === 'pollAccount').length, 0);
    h.alarms.delete('pollAccount');
    await h.run('initialize()');
    assert.equal(h.alarmCreates.filter(name => name === 'pollAccount').length, 1);
});

test('console saves one minute and requests an immediate check once when countdown expires', async () => {
    const h = harness('control.js');
    await new Promise(setImmediate);
    h.element('idleMinutes').value = '1';
    h.element('idleEnabled').checked = true;
    await h.run('saveCfg("schedule"); HANDLE = "Alice"');
    assert.equal(h.storage.cfg.idleMinutes, 1);
    h.storage.lastAcTs = Date.now() - 61000;
    let polls = 0;
    h.context.chrome.runtime.sendMessage = async request => {
        if (request.action === 'POLL_ACCOUNT') polls++;
        return { ok: true };
    };
    const countdown = h.intervals.find(tick => tick.toString().includes('idleCountdown'));
    countdown();
    await new Promise(setImmediate);
    assert.equal(polls, 1);
    assert.match(h.element('idleRemain').innerText, /已到期/);
    countdown();
    await new Promise(setImmediate);
    assert.equal(polls, 1);
    await h.run('requestMonitorTick()');
    assert.equal(polls, 2);
});


test('schedule edits preserve arming while physical edits still disarm', async () => {
    const h = harness('control.js', { emitStorageChanges: true });
    await new Promise(setImmediate);
    h.run('char = fakeConnection; connectionManager.armed = true');
    h.element('idleMinutes').value = '2';
    h.element('idleEnabled').checked = true;
    await h.run('saveCfg("schedule")');
    await new Promise(setImmediate);
    assert.equal(h.run('connectionManager.armed'), true);
    assert.equal(h.writes.length, 0);
    h.element('strengthSlider').value = '10';
    await h.run('saveCfg()');
    assert.equal(h.run('connectionManager.armed'), false);
});

test('idle configuration resets only the round clock, leaving actual AC time intact', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    Object.assign(h.storage, { lastAcTs: 123, idleStartedAt: 456, cfg: { idleEnabled: true, idleMinutes: 1 } });
    await h.run('setCfg({ idleMinutes: 2 })');
    assert.equal(h.storage.lastAcTs, 123);
    assert.ok(h.storage.idleStartedAt > 456);
    assert.equal(h.storage.idleNextAt - h.storage.idleStartedAt, 120000);
    const start = h.storage.idleStartedAt;
    await h.run('setCfg({ cdSeconds: 20 })');
    assert.equal(h.storage.idleStartedAt, start);
    assert.equal(h.storage.cfg.idleMinutes, 2);
});

for (const action of ['skip', 'retry']) {
    test('idle cooldown action ' + action + ' has explicit scheduling and does not overwrite AC', async () => {
        const h = harness('background.js');
        await new Promise(setImmediate);
        const now = Date.now();
        Object.assign(h.storage, { cfHandle: 'Alice', cfg: { idleEnabled: true, idleMinutes: 1, cdSeconds: 60, idleCooldownAction: action },
            automation: { simulation: true }, lastAcTs: 123, idleStartedAt: now - 61000, lastPollTs: now, lastSimTs: now - 10000 });
        await h.run('idleTick()');
        assert.equal(h.storage.lastAcTs, 123);
        assert.equal(h.storage.eventLog[0].status, 'skipped');
        assert.equal(h.storage.idleRetryPending, action === 'retry');
        if (action === 'retry') {
            assert.equal(h.storage.idleNextAt, h.storage.lastSimTs + 60000);
            await h.run('idleTick()');
            assert.equal(h.storage.eventLog.length, 1);
            h.storage.lastSimTs = now - 61000;
            h.storage.idleNextAt = now - 1;
            await h.run('idleTick()');
            assert.equal(h.storage.eventLog[0].status, 'simulated');
            assert.equal(h.storage.lastAcTs, 123);
        } else assert.ok(h.storage.idleStartedAt >= now);
    });
}

test('resuming output clears a deferred idle retry instead of replaying it', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    Object.assign(h.storage, { idleRetryPending: true, idleNextAt: 10, lastAcTs: 123, cfg: { idleMinutes: 1 } });
    await h.run('clearIdleRetry()');
    assert.equal(h.storage.idleRetryPending, false);
    assert.ok(h.storage.idleNextAt > Date.now());
    assert.equal(h.storage.lastAcTs, 123);
});

test('latest trigger explanation displays both a skipped event and sync errors', async () => {
    const h = harness('control.js');
    await new Promise(setImmediate);
    h.run('renderEventLog([{ ts: Date.now(), verdict: "无 AC 到期", status: "skipped", reason: "冷却剩余 12 秒" }])');
    assert.match(h.element('latestTriggerResult').textContent, /冷却剩余 12 秒/);
    for (const listener of h.listeners) listener({ monitorError: { newValue: 'offline' } }, 'local');
    assert.match(h.element('latestTriggerResult').textContent, /同步失败.*等待重试/);
});


test('paused idle expiry skips the round even with cooldown retry selected', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    const now = Date.now();
    Object.assign(h.storage, { cfHandle: 'Alice', cfg: { idleEnabled: true, idleMinutes: 1, cdSeconds: 60, idleCooldownAction: 'retry' },
        idleStartedAt: now - 61000, lastAcTs: 123, lastPollTs: now, lastZapTs: now, panicUntil: now + 60000 });
    await h.run('idleTick()');
    assert.equal(h.storage.idleRetryPending, false);
    assert.match(h.storage.eventLog[0].reason, /紧急停止.*本轮跳过/);
    assert.equal(h.storage.zapSeq, undefined);
    assert.equal(h.storage.lastAcTs, 123);
});

test('legacy timer migration does not present old timer resets as actual AC times', async () => {
    const h = harness('background.js');
    await new Promise(setImmediate);
    Object.assign(h.storage, { cfHandle: 'Alice', monitor: { cursor: 100, pending: [] }, lastAcTs: 123 });
    await h.run('initialize()');
    assert.equal(h.storage.idleStartedAt, 123);
    assert.equal(h.storage.lastAcTs, 0);
    h.storage.lastAcTs = 456;
    await h.run('initialize()');
    assert.equal(h.storage.lastAcTs, 456);
});
