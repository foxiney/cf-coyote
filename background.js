importScripts('core.js');
// All Codeforces requests and submission state updates have one owner.
const FAIL_VERDICTS = {
    WRONG_ANSWER: 'wrong answer', TIME_LIMIT_EXCEEDED: 'time limit',
    RUNTIME_ERROR: 'runtime error', COMPILATION_ERROR: 'compilation error',
    MEMORY_LIMIT_EXCEEDED: 'memory limit', IDLENESS_LIMIT_EXCEEDED: 'idleness limit',
    CHALLENGED: 'hacked'
};
let apiQueue = Promise.resolve();
let stateQueue = Promise.resolve();
let nextApiAt = 0;
let lastPollAt = 0;
function serialize(work) {
    const job = stateQueue.then(work);
    stateQueue = job.catch(() => {});
    return job;
}
function cfApi(method, params = {}) {
    const job = apiQueue.then(async () => {
        const { apiNextAt = 0 } = await chrome.storage.local.get('apiNextAt');
        const delay = Math.max(nextApiAt, apiNextAt) - Date.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        nextApiAt = Date.now() + 2100;
        await chrome.storage.local.set({ apiNextAt: nextApiAt });
        const response = await fetch(`https://codeforces.com/api/${method}?${new URLSearchParams(params)}`,
            { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Codeforces HTTP ${response.status}`);
        const data = await response.json();
        if (data.status !== 'OK') throw new Error(data.comment || 'Codeforces API 请求失败');
        return data;
    });
    apiQueue = job.catch(() => {});
    return job;
}
async function setAccount(value) {
    const handle = String(value || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(handle)) throw new Error('用户名需为 3–24 位字母、数字、下划线、点或短横线');
    const user = (await cfApi('user.info', { handles: handle })).result[0];
    const old = await chrome.storage.local.get(['cfHandle', 'monitor', 'practice']);
    if (old.cfHandle?.toLowerCase() === user.handle.toLowerCase() && old.monitor) return user.handle;
    const latest = (await cfApi('user.status', { handle: user.handle, from: 1, count: 1 })).result;
    const { zapSeq = 0 } = await chrome.storage.local.get('zapSeq');
    await chrome.storage.local.set({
        cfHandle: user.handle, monitor: { cursor: latest[0]?.id || 0, pending: [] },
        comboCount: 0, lastAcTs: Date.now(), zapAck: zapSeq, zapInfo: null,
        zapStats: { date: new Date().toDateString(), count: 0 }, monitorError: '',
        practice: { enabled: old.practice?.enabled || false, active: false }, policyRevision: Date.now()
    });
    await chrome.storage.local.remove(['pendingSubs', 'lastSeenId']);
    await chrome.alarms.create('pollAccount', { periodInMinutes: 1 });
    lastPollAt = 0;
    return user.handle;
}
async function pollAccount() {
    const state = await chrome.storage.local.get(['cfHandle', 'monitor', 'comboCount', 'zapSeq', 'panicUntil', 'automation', 'cfg', 'practice']);
    if (!state.cfHandle || !state.monitor || Date.now() - lastPollAt < 15000) return;
    if (!Coyote.sessionActive(state.practice)) return;
    lastPollAt = Date.now();
    try {
        const subs = (await cfApi('user.status', { handle: state.cfHandle, from: 1, count: 1000 })).result;
        const pending = new Set(state.monitor.pending);
        let cursor = state.monitor.cursor;
        let combo = state.comboCount || 0;
        let failure = null;
        let ac = false;
        const policy = Coyote.automation(state.automation);
        for (const sub of [...subs].sort((a, b) => a.id - b.id)) {
            if (sub.id <= state.monitor.cursor && !pending.has(sub.id)) continue;
            cursor = Math.max(cursor, sub.id);
            if (!Coyote.includesSubmission(state.practice, sub)) { pending.delete(sub.id); continue; }
            if (!sub.verdict || sub.verdict === 'TESTING') { pending.add(sub.id); continue; }
            pending.delete(sub.id);
            if (sub.verdict === 'OK') {
                combo = 0; ac = true;
                await appendLog({ subId: String(sub.id), verdict: 'AC', handle: state.cfHandle, status: 'accepted', reason: '连败已清零' });
            }
            else if (FAIL_VERDICTS[sub.verdict]) {
                const rule = policy.rules[sub.verdict];
                const info = { subId: String(sub.id), verdict: Coyote.verdicts[sub.verdict], verdictCode: sub.verdict,
                    contestId: sub.contestId, ts: Date.now(), handle: state.cfHandle };
                if (rule.action === 'ignore') {
                    await appendLog({ ...info, status: 'ignored', reason: '规则设为忽略，不计入连败' });
                    continue;
                }
                combo++;
                info.combo = combo;
                if (rule.action === 'log') await appendLog({ ...info, status: 'log', reason: '规则设为仅记录' });
                else {
                    if (failure) await appendLog({ ...failure, status: 'skipped', reason: '同批判题合并为一次触发' });
                    failure = info;
                }
            }
        }
        const patch = { monitor: { cursor, pending: [...pending] }, comboCount: combo,
            monitorError: '', lastPollTs: Date.now() };
        if (ac) patch.lastAcTs = Date.now();
        await chrome.storage.local.set(patch);
        if (failure) await dispatchEvent(failure);
    } catch (error) {
        await chrome.storage.local.set({ monitorError: error.message });
        throw error;
    }
}
async function idleTick() {
    const d = await chrome.storage.local.get(['cfg', 'cfHandle', 'lastAcTs', 'panicUntil', 'zapSeq', 'practice']);
    if (!d.cfHandle || !d.cfg?.idleEnabled || !Coyote.sessionActive(d.practice)) return;
    const now = Date.now();
    const duration = Math.max(5, Math.min(240, Number(d.cfg.idleMinutes) || 30)) * 60000;
    if (!d.lastAcTs) { await chrome.storage.local.set({ lastAcTs: now }); return; }
    if (now - d.lastAcTs < duration) return;
    await chrome.storage.local.set({ lastAcTs: now });
    await dispatchEvent({ subId: '--', verdict: `idle ${duration / 60000}min no AC`, combo: 1, ts: now, handle: d.cfHandle });
}
chrome.runtime.onMessage.addListener((request, sender, reply) => {
    const consolePage = sender.url === chrome.runtime.getURL('control.html');
    let work;
    if (request.action === 'POLL_ACCOUNT') work = serialize(pollAccount);
    else if (consolePage && request.action === 'SET_ACCOUNT') work = serialize(() => setAccount(request.handle));
    else if (consolePage && request.action === 'SET_AUTOMATION') work = serialize(() => setAutomation(request.value));
    else if (consolePage && request.action === 'PRACTICE') work = serialize(() => setPractice(request));
    else if (consolePage && request.action === 'SIMULATE') work = serialize(() => simulateVerdict(request.verdict));
    else if (consolePage && request.action === 'RECORD_OUTPUT') work = serialize(() => recordOutput(request.entry));
    else if (consolePage && request.action === 'CLEAR_LOG') work = serialize(() => chrome.storage.local.set({ eventLog: [] }));
    else if (consolePage && request.action === 'CF_API' && ['user.info', 'user.status', 'user.rating', 'contest.list'].includes(request.method)) {
        work = cfApi(request.method, request.params);
    } else return false;
    work.then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message }));
    return true;
});
chrome.action.onClicked.addListener(async () => {
    const url = chrome.runtime.getURL('control.html');
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find(tab => tab.url === url);
    if (existing) await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ url });
});
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'practiceEnd') serialize(expirePractice).catch(console.error);
    if (alarm.name === 'pollAccount') serialize(async () => {
        await expirePractice();
        await pollAccount();
        await idleTick();
    }).catch(console.error);
});
async function initialize() {
    await chrome.alarms.clear('pollPending');
    await chrome.alarms.clear('idleZap');
    await expirePractice();
    const { practice } = await chrome.storage.local.get('practice');
    if (practice?.active) await chrome.alarms.create('practiceEnd', { when: practice.endsAt });
    const { cfHandle, monitor } = await chrome.storage.local.get(['cfHandle', 'monitor']);
    if (cfHandle && monitor) await chrome.alarms.create('pollAccount', { periodInMinutes: 1 });
}
serialize(initialize).catch(console.error);

async function appendLog(entry) {
    const { eventLog = [] } = await chrome.storage.local.get('eventLog');
    const item = { ts: Date.now(), id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ...entry };
    await chrome.storage.local.set({ eventLog: [item, ...eventLog.filter(old => old.id !== item.id)].slice(0, 100) });
    return item;
}
async function recordOutput(entry) {
    if (!entry || !['executed', 'skipped', 'error'].includes(entry.status)) throw new Error('无效的输出记录');
    const { eventLog = [], zapStats } = await chrome.storage.local.get(['eventLog', 'zapStats']);
    const old = eventLog.find(item => item.id === entry.id);
    if (old?.status === 'executed') return;
    await appendLog({ ...old, ...entry });
    if (entry.status === 'executed') {
        const today = new Date().toDateString();
        await chrome.storage.local.set({ zapStats: { date: today, count: (zapStats?.date === today ? zapStats.count : 0) + 1 } });
    }
}
async function dispatchEvent(info, forceSimulation = false) {
    const d = await chrome.storage.local.get(['automation', 'cfg', 'practice', 'panicUntil', 'lastSimTs', 'lastZapTs', 'zapSeq', 'policyRevision']);
    const policy = Coyote.automation(d.automation);
    const simulation = forceSimulation || policy.simulation;
    const rule = policy.rules[info.verdictCode] || {};
    const power = Coyote.power(d.cfg, rule, info.combo);
    const reason = Coyote.blocked(d, simulation) || (power <= 0 ? '强度为 0' : '');
    if (reason) return appendLog({ ...info, simulation, power, status: 'skipped', reason });
    if (simulation) {
        await chrome.storage.local.set({ lastSimTs: Date.now() });
        return appendLog({ ...info, simulation: true, power, status: 'simulated', reason: '模拟模式：未发送蓝牙输出' });
    }
    const event = await appendLog({ ...info, power, status: 'pending', reason: '等待已连接的控制台',
        policyRevision: d.policyRevision || 0, sessionId: d.practice?.active ? d.practice.id : null });
    await chrome.storage.local.set({ zapSeq: (d.zapSeq || 0) + 1, zapInfo: event });
    return event;
}
async function setAutomation(value) {
    const { zapSeq = 0, policyRevision = 0 } = await chrome.storage.local.get(['zapSeq', 'policyRevision']);
    await chrome.storage.local.set({ automation: Coyote.automation(value), policyRevision: policyRevision + 1,
        zapAck: zapSeq, zapInfo: null });
}
async function setPractice(request) {
    const d = await chrome.storage.local.get(['cfHandle', 'monitor', 'zapSeq', 'practice', 'policyRevision']);
    if (!['start', 'stop', 'all'].includes(request.mode)) throw new Error('无效的会话操作');
    if (!d.cfHandle || !d.monitor) throw new Error('请先保存 Codeforces 用户名');
    let practice = { ...d.practice, enabled: request.mode !== 'all', active: false };
    let monitor = d.monitor;
    if (request.mode === 'start' || request.mode === 'all') {
        const contestId = Number(request.contestId), minutes = Number(request.minutes);
        if (request.mode === 'start' && (!Number.isSafeInteger(contestId) || contestId <= 0 || !Number.isInteger(minutes) || minutes < 1 || minutes > 480)) {
            throw new Error('比赛 ID 须为正整数，时长为 1–480 分钟');
        }
        const latest = (await cfApi('user.status', { handle: d.cfHandle, from: 1, count: 1 })).result;
        monitor = { cursor: latest[0]?.id || 0, pending: [] };
        if (request.mode === 'start') {
            const startedAt = Date.now();
            practice = { enabled: true, active: true, contestId, startedAt,
                endsAt: startedAt + minutes * 60000, id: `${startedAt}-${contestId}` };
        }
    }
    await chrome.storage.local.set({ practice, monitor, comboCount: 0, lastAcTs: Date.now(),
        zapAck: d.zapSeq || 0, zapInfo: null, policyRevision: (d.policyRevision || 0) + 1 });
    await chrome.alarms.clear('practiceEnd');
    if (practice.active) await chrome.alarms.create('practiceEnd', { when: practice.endsAt });
    await appendLog({ status: 'session', reason: request.mode === 'start' ? `开始比赛 ${practice.contestId} 练习` :
        request.mode === 'all' ? '已切换到全部新提交监控' : '练习已结束；自动触发保持停止' });
    lastPollAt = 0;
    return practice;
}
async function expirePractice() {
    const { practice, zapSeq = 0, policyRevision = 0 } = await chrome.storage.local.get(['practice', 'zapSeq', 'policyRevision']);
    if (!practice?.active || Date.now() < practice.endsAt) return;
    await chrome.storage.local.set({ practice: { ...practice, active: false }, zapAck: zapSeq,
        zapInfo: null, policyRevision: policyRevision + 1 });
    await appendLog({ status: 'session', reason: '练习时间已到，自动触发已停止' });
}
async function simulateVerdict(code) {
    if (!Coyote.verdicts[code]) throw new Error('请选择有效判题');
    const { automation, cfHandle } = await chrome.storage.local.get(['automation', 'cfHandle']);
    const rule = Coyote.automation(automation).rules[code];
    const info = { verdict: Coyote.verdicts[code], verdictCode: code, subId: 'TEST', combo: 1, handle: cfHandle, ts: Date.now() };
    if (rule.action !== 'output') return appendLog({ ...info, status: rule.action === 'ignore' ? 'ignored' : 'log', reason: '模拟测试遵循判题规则' });
    return dispatchEvent(info, true);
}
