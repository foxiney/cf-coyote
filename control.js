// control.js - 郊狼控制中心 v2
let char = null;
let HANDLE = '';
let accountGeneration = 0;
async function cfApi(method, params) {
    const response = await chrome.runtime.sendMessage({ action: 'CF_API', method, params });
    if (!response?.ok) throw new Error(response?.error || '后台请求失败');
    return response.result;
}
function reportError(error) {
    console.error(error);
    document.getElementById('accountStatus').textContent = error.message;
}
async function loadAccount() {
    const { cfHandle = '' } = await chrome.storage.local.get('cfHandle');
    HANDLE = cfHandle;
    accountGeneration++;
    document.getElementById('handleDisplay').textContent = HANDLE || '设置你的 Codeforces 账号';
    document.getElementById('handleInput').value = HANDLE;
    applyTheme('newbie', '—');
    for (const id of ['totalSolved', 'todayAC', 'todaySubmits']) document.getElementById(id).textContent = '—';
    document.getElementById('acRate').textContent = '--%';
    for (const id of ['ratingChart', 'chartDelta', 'acContainer', 'diffTags']) document.getElementById(id).replaceChildren();
    if (HANDLE) { syncCFStats(); syncRatingChart(); }
}
document.getElementById('accountForm').onsubmit = async event => {
    event.preventDefault();
    const button = document.getElementById('saveHandle');
    button.disabled = true;
    document.getElementById('accountStatus').textContent = '正在验证账号并建立监控起点…';
    cancelOutput();
    try {
        const response = await chrome.runtime.sendMessage({ action: 'SET_ACCOUNT', handle: document.getElementById('handleInput').value });
        if (!response?.ok) throw new Error(response?.error || '保存失败');
        document.getElementById('accountStatus').textContent = `已保存 ${response.result}，仅监控新提交`;
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
};

// 精准对应 CF 等级颜色
const RANK_MAP = {
    "newbie": { color: "#808080", rgb: "128,128,128" },
    "pupil": { color: "#008000", rgb: "0,128,0" },
    "specialist": { color: "#03a89e", rgb: "3,168,158" },
    "expert": { color: "#0000ff", rgb: "0,0,255" },
    "candidate master": { color: "#aa00aa", rgb: "170,0,170" },
    "master": { color: "#ff8c00", rgb: "255,140,0" },
    "international master": { color: "#ff8c00", rgb: "255,140,0" },
    "grandmaster": { color: "#ff0000", rgb: "255,0,0" },
    "international grandmaster": { color: "#ff0000", rgb: "255,0,0" },
    "legendary grandmaster": { color: "#ff0000", rgb: "255,0,0" }
};

const slider = document.getElementById('strengthSlider');
const strengthVal = document.getElementById('strengthVal');
const chanA = document.getElementById('chanA');
const chanB = document.getElementById('chanB');
const comboStepInput = document.getElementById('comboStep');
const idleEnabledInput = document.getElementById('idleEnabled');
const idleMinutesInput = document.getElementById('idleMinutes');
const cdSecondsInput = document.getElementById('cdSeconds');
const panicBtn = document.getElementById('panicBtn');

// ---------- 多语言 ----------
const I18N = {
    zh: {
        totalSolved: '近 5000 次提交解题数', todayAc: '今日 AC', rating: '当前分数',
        secAc: '今日 AC 列表', secPunish: '输出参数', secLog: '电击日志',
        secStats: '今日战况', submits: '提交', zaps: '被电', acRate: 'AC 率',
        secChart: 'RATING 走势', secDiff: '难度分布', secContest: '下一场比赛',
        noDiff: '暂无数据', noContest: '暂无即将开始的比赛',
        idleRemainL: '距离惩罚',
        cdL: '冷却时间', seconds: '秒',
        panic: '🛑 紧急停止', panicActive: '🛑 已暂停 1 小时 · 点击恢复',
        gaugeMeta: '基础强度\n0 - 100',
        streak: '连败', nextPower: '下次强度: ',
        comboStepL: '连败递增', perLoss: '/ 场',
        idleL: '无 AC 惩罚', minutes: '分钟',
        chanAL: '通道 A', chanBL: '通道 B',
        connect: '连接郊狼 V3', connected: '已连接 ✓', reconnect: '重新连接郊狼',
        test: '手动触发',
        noAcToday: '今日尚未达成 AC。', syncing: '正在同步最新提交记录...',
        noZap: '暂无电击记录。', discharging: '⚡ 放电中_',
        strength: '强度',
        connectFirst: '请先连接郊狼硬件！', connFail: '连接失败: '
    },
    en: {
        totalSolved: 'SOLVED (LAST 5000)', todayAc: 'TODAY AC', rating: 'RATING',
        secAc: "TODAY'S AC", secPunish: 'PUNISHMENT', secLog: 'ZAP LOG',
        secStats: "TODAY'S BATTLE", submits: 'SUBMITS', zaps: 'ZAPPED', acRate: 'AC RATE',
        secChart: 'RATING GRAPH', secDiff: 'DIFFICULTY', secContest: 'NEXT CONTEST',
        noDiff: 'No data yet', noContest: 'No upcoming contest',
        idleRemainL: 'ZAP IN',
        cdL: 'COOLDOWN', seconds: 'sec',
        panic: '🛑 PANIC STOP', panicActive: '🛑 PAUSED 1H · CLICK TO RESUME',
        gaugeMeta: 'BASE INTENSITY\n0 - 100',
        streak: 'STREAK', nextPower: 'Next: ',
        comboStepL: 'COMBO STEP', perLoss: '/ loss',
        idleL: 'IDLE ZAP', minutes: 'min',
        chanAL: 'CHANNEL A', chanBL: 'CHANNEL B',
        connect: 'CONNECT COYOTE V3', connected: 'LINK ESTABLISHED ✓', reconnect: 'RECONNECT COYOTE V3',
        test: 'MANUAL TRIGGER',
        noAcToday: 'No AC yet today.', syncing: 'Syncing submissions...',
        noZap: 'No zaps recorded.', discharging: '⚡ DISCHARGING_',
        strength: 'PWR ',
        connectFirst: 'Connect the Coyote first!', connFail: 'Connection failed: '
    }
};
let lang = 'zh';
let bleState = 'disconnected';
function t(k) { return (I18N[lang] || I18N.zh)[k] ?? k; }

function setConnectBtnText() {
    const btn = document.getElementById('connectBtn');
    btn.innerText = bleState === 'connected' ? t('connected')
                  : bleState === 'reconnect' ? t('reconnect')
                  : t('connect');
}

function applyLang() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.innerText = t(el.dataset.i18n); });
    document.getElementById('zapNotify').innerText = t('discharging');
    document.getElementById('langBtn').innerText = lang === 'zh' ? 'EN' : '中文';
    setConnectBtnText();
    if (typeof updatePanicUI === 'function') updatePanicUI();
    updateComboUIFromStorage();
}

document.getElementById('langBtn').onclick = () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    chrome.storage.local.set({ lang });
    applyLang();
};
chrome.storage.local.get('lang', d => { lang = d.lang || 'zh'; applyLang(); });

// ---------- 设置持久化 ----------
function saveCfg(group = 'output') {
    const scheduling = group === 'schedule';
    if (!scheduling) cancelOutput();
    const value = scheduling ? {
        idleEnabled: idleEnabledInput.checked,
        idleMinutes: Math.max(1, Math.min(240, +idleMinutesInput.value || 30)),
        cdSeconds: Math.max(0, Math.min(600, +cdSecondsInput.value || 0)),
        idleCooldownAction: document.getElementById('idleCooldownAction').value
    } : {
        strength: +slider.value, useA: chanA.checked, useB: chanB.checked,
        comboStep: Math.max(0, Math.min(20, +comboStepInput.value || 0))
    };
    return featureRequest('SET_CFG', { value }).then(() => {
        document.getElementById('settingsStatus').textContent = scheduling
            ? '调度设置已保存，输出启用状态保留；开启计时或修改时长从现在重新计时。'
            : '输出参数已保存，请重新启用输出。';
    }).catch(reportError);
}
function outputCfgChanged(before = {}, after = {}) {
    return ['strength', 'useA', 'useB', 'comboStep'].some(key =>
        (before[key] ?? ({ strength: 20, useA: true, useB: true, comboStep: 5 })[key]) !==
        (after[key] ?? ({ strength: 20, useA: true, useB: true, comboStep: 5 })[key]));
}
function applyCfg(cfg = {}) {
    slider.value = cfg.strength ?? 20;
    strengthVal.innerText = slider.value;
    chanA.checked = cfg.useA ?? true;
    chanB.checked = cfg.useB ?? true;
    comboStepInput.value = cfg.comboStep ?? 5;
    idleEnabledInput.checked = cfg.idleEnabled ?? false;
    idleMinutesInput.value = cfg.idleMinutes ?? 30;
    cdSecondsInput.value = cfg.cdSeconds ?? 60;
    document.getElementById('idleCooldownAction').value = cfg.idleCooldownAction || 'skip';
}
chrome.storage.local.get(['cfg', 'comboCount'], ({ cfg, comboCount }) => {
    applyCfg(cfg);
    updateComboUI(comboCount || 0);
});
slider.oninput = function () { strengthVal.innerText = this.value; saveCfg(); updateComboUIFromStorage(); };
chanA.onchange = chanB.onchange = saveCfg;
comboStepInput.onchange = () => { saveCfg(); updateComboUIFromStorage(); };
idleMinutesInput.onchange = cdSecondsInput.onchange = idleEnabledInput.onchange = () => saveCfg('schedule');
document.getElementById('idleCooldownAction').onchange = () => saveCfg('schedule');

// ---------- 连败 Combo ----------
// 连败惩罚：基础强度 + 每连败一场 +step（可配置），递增封顶 5 档，总上限 100
function comboPower(base, combo) {
    const step = Math.max(0, Math.min(20, +comboStepInput.value || 0));
    return Math.min(100, base + step * Math.min(Math.max(combo, 1) - 1, 5));
}
function updateComboUI(combo) {
    const el = document.getElementById('comboVal');
    const next = document.getElementById('nextPower');
    if (el) el.innerText = combo;
    if (next) next.innerText = t('nextPower') + comboPower(+slider.value, combo + 1);
}
function updateComboUIFromStorage() {
    chrome.storage.local.get('comboCount', d => updateComboUI(d.comboCount || 0));
}

// ---------- CF 数据同步 ----------
function applyTheme(rank, rating) {
    const theme = RANK_MAP[rank.toLowerCase()] || RANK_MAP["newbie"];
    document.documentElement.style.setProperty('--cf-color', theme.color);
    document.documentElement.style.setProperty('--cf-rgb', theme.rgb);
    document.getElementById('rankTag').innerText = rank;
    document.getElementById('currentRating').innerText = rating;
}

let statsBusy = false;
async function syncCFStats() {
    if (!HANDLE || statsBusy) return;
    statsBusy = true;
    const handle = HANDLE, generation = accountGeneration;
    try {
        const userData = await cfApi('user.info', { handles: handle });
        if (generation !== accountGeneration) return;
        if (userData.status === "OK") {
            const u = userData.result[0];
            applyTheme(u.rank || "newbie", u.rating || 0);
        }

        const statusData = await cfApi('user.status', { handle, from: 1, count: 5000 });
        if (generation !== accountGeneration) return;
        if (statusData.status === "OK") {
            const todayStart = new Date().setHours(0, 0, 0, 0) / 1000;
            const solvedAll = new Set();
            const solvedToday = [];
            const diffToday = [];
            let todaySubmits = 0, todayAcCnt = 0;

            statusData.result.forEach(s => {
                const isToday = s.creationTimeSeconds >= todayStart;
                if (isToday && s.verdict && s.verdict !== 'TESTING') {
                    todaySubmits++;
                    if (s.verdict === 'OK') todayAcCnt++;
                }
                if (s.verdict === "OK") {
                    const probKey = `${s.problem.contestId ?? s.problem.problemsetName}:${s.problem.index}`;
                    if (!solvedAll.has(probKey)) {
                        solvedAll.add(probKey);
                        if (isToday) {
                            solvedToday.push(`${s.problem.index} - ${s.problem.name}`);
                            if (s.problem.rating) diffToday.push(s.problem.rating);
                        }
                    }
                }
            });

            document.getElementById('totalSolved').innerText = solvedAll.size;
            document.getElementById('todayAC').innerText = solvedToday.length;
            const acBox = document.getElementById('acContainer');
            acBox.replaceChildren();
            for (const text of solvedToday.length ? solvedToday.map(name => `✔ ${name}`) : [t('noAcToday')]) {
                const item = document.createElement('div');
                item.className = 'ac-item';
                item.textContent = text;
                acBox.append(item);
            }

            // 今日战况
            document.getElementById('todaySubmits').innerText = todaySubmits;
            document.getElementById('acRate').innerText = todaySubmits > 0
                ? Math.round(100 * todayAcCnt / todaySubmits) + '%' : '--%';

            // 难度分布
            const diffBox = document.getElementById('diffTags');
            if (diffToday.length > 0) {
                diffToday.sort((a, b) => a - b);
                diffBox.innerHTML = diffToday.map(r =>
                    `<span class="diff-tag" style="color:${diffColor(r)}; border-color:${diffColor(r)}44;">${r}</span>`
                ).join('');
            } else {
                diffBox.innerHTML = `<span style="color:#475569; font-size:11px;">${t('noDiff')}</span>`;
            }

        }
    } catch (e) { if (generation === accountGeneration) reportError(e); }
    finally {
        statsBusy = false;
        if (generation !== accountGeneration && HANDLE) syncCFStats();
    }
}

// 题目难度 → CF 配色
function diffColor(r) {
    if (r < 1200) return '#9ca3af';
    if (r < 1400) return '#22c55e';
    if (r < 1600) return '#06b6d4';
    if (r < 1900) return '#3b82f6';
    if (r < 2100) return '#a855f7';
    if (r < 2400) return '#f97316';
    return '#ef4444';
}

// ---------- Rating 走势图 ----------
async function syncRatingChart() {
    if (!HANDLE) return;
    const generation = accountGeneration;
    try {
        const data = await cfApi('user.rating', { handle: HANDLE });
        if (generation !== accountGeneration) return;
        if (data.status !== "OK" || data.result.length === 0) return;

        const pts = data.result.slice(-10).map(c => c.newRating);
        const deltaEl = document.getElementById('chartDelta');
        const last = data.result[data.result.length - 1];
        const delta = last.newRating - last.oldRating;
        deltaEl.innerText = (delta >= 0 ? '+' : '') + delta;
        deltaEl.style.color = delta >= 0 ? 'var(--green)' : 'var(--danger)';

        const svg = document.getElementById('ratingChart');
        const W = 300, H = 74, PAD = 8;
        const min = Math.min(...pts), max = Math.max(...pts);
        const span = Math.max(max - min, 1);
        const x = i => PAD + i * (W - 2 * PAD) / Math.max(pts.length - 1, 1);
        const y = v => H - PAD - (v - min) * (H - 2 * PAD) / span;
        const lineStr = pts.map((v, i) => `${x(i)},${y(v)}`).join(' ');

        svg.innerHTML = `
            <polyline points="${PAD},${H - PAD} ${lineStr} ${W - PAD},${H - PAD}"
                fill="rgba(var(--cf-rgb),0.12)" stroke="none"/>
            <polyline points="${lineStr}" fill="none"
                stroke="var(--cf-color)" stroke-width="2" stroke-linejoin="round"/>
            ${pts.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="var(--cf-color)"/>`).join('')}
        `;
    } catch (e) { console.error("Rating Chart Error", e); }
}
syncRatingChart();
setInterval(syncRatingChart, 300000);

// ---------- 下一场比赛倒计时 ----------
let nextContestStart = null;
async function syncContest() {
    try {
        const data = await cfApi('contest.list', { gym: false });
        if (data.status !== "OK") return;

        // 比赛列表仅用于显示；其他人的比赛不影响当前账号的计时。


        const upcoming = data.result
            .filter(c => c.phase === 'BEFORE')
            .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)[0];
        if (upcoming) {
            nextContestStart = upcoming.startTimeSeconds * 1000;
            document.getElementById('contestName').innerText = upcoming.name;
        } else {
            nextContestStart = null;
            document.getElementById('contestName').innerText = t('noContest');
        }
    } catch (e) { console.error("Contest Sync Error", e); }
}
syncContest();
setInterval(syncContest, 600000);

// ---------- 今日被电计数 ----------
chrome.storage.local.get('zapStats', ({ zapStats }) => {
    const today = new Date().toDateString();
    document.getElementById('todayZaps').innerText =
        (zapStats && zapStats.date === today) ? zapStats.count : 0;
});

// ---------- 每秒滴答：无AC倒计时 + 比赛倒计时 ----------
function fmtHMS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
}

let lastIdleDueAnchor = null;
setInterval(() => {
    // 比赛倒计时
    if (nextContestStart) {
        const diff = nextContestStart - Date.now();
        document.getElementById('contestTimer').innerText = diff > 0 ? fmtHMS(diff) : 'LIVE!';
    }

    // 无AC惩罚倒计时
    const box = document.getElementById('idleCountdown');
    if (!idleEnabledInput.checked || !Coyote.sessionActive(currentPractice)) {
        box.classList.remove('active');
        return;
    }
    box.classList.add('active');
    chrome.storage.local.get(['lastAcTs', 'idleStartedAt', 'idleNextAt'], ({ lastAcTs, idleStartedAt, idleNextAt }) => {
        const total = Math.max(1, Math.min(240, +idleMinutesInput.value || 30)) * 60000;
        const elapsed = Date.now() - (lastAcTs || Date.now());
        const remain = total - elapsed;
        const dueKey = `${lastAcTs}:${total}`;
        if (remain <= 0 && lastAcTs && lastIdleDueAnchor !== dueKey) {
            lastIdleDueAnchor = dueKey;
            requestMonitorTick();
        }
        const remainEl = document.getElementById('idleRemain');
        remainEl.innerText = remain > 0 ? fmtHMS(remain) : '已到期 · 等待同步检查';
        remainEl.classList.toggle('urgent', remain < 5 * 60000);
        document.getElementById('idleBar').style.width =
            Math.max(0, Math.min(100, 100 * remain / total)) + '%';
    });
}, 1000);

syncCFStats();
setInterval(syncCFStats, 300000);

// The console must also drive monitoring when no Codeforces tab is open.
let monitorBusy = false;
async function requestMonitorTick() {
    if (monitorBusy || !HANDLE) return;
    monitorBusy = true;
    try {
        const response = await chrome.runtime.sendMessage({ action: 'POLL_ACCOUNT' });
        if (!response?.ok) throw new Error(response?.error || '判题同步失败');
    } catch (error) { reportError(error); }
    finally { monitorBusy = false; }
}
setInterval(requestMonitorTick, 15000);

// ---------- 蓝牙连接 ----------
const connectionManager = new CoyoteConnection({
    locks: navigator.locks,
    initialize: connectBle,
    stop: () => cancelOutput(),
    onState(state, message) {
        bleState = state;
        if (state !== 'connected') {
            outputGeneration++;
            document.getElementById('zapNotify').style.display = 'none';
        }
        if (state === 'disconnected' || state === 'error') {
            writeEpoch++;
            writeQueue = Promise.resolve();
            char = null;
            document.getElementById('deviceStrength').textContent = '设备未连接';
            document.getElementById('batteryLevel').textContent = '电量：未连接';
        }
        document.getElementById('connectionStatus').textContent = message;
        updateConnectionUI();
    }
});
function updateConnectionUI() {
    const state = connectionManager.state;
    const labels = { disconnected: '连接郊狼 V3', connecting: '正在连接…', connected: '已连接', disconnecting: '正在断开…', error: '重试连接' };
    const button = document.getElementById('connectBtn');
    button.textContent = labels[state];
    button.disabled = ['connecting', 'connected', 'disconnecting'].includes(state);
    document.getElementById('disconnectBtn').disabled = !['connecting', 'connected'].includes(state);
    const arm = document.getElementById('armOutputBtn');
    arm.textContent = connectionManager.armed ? '关闭输出' : '启用输出（含自动触发）';
    arm.disabled = state !== 'connected' || simulationMode || isPanic() || !Coyote.sessionActive(currentPractice);
    document.getElementById('outputStatus').textContent = connectionManager.armed ? '输出已启用 · 仅处理启用后的新事件' : '输出未启用';
    updateOutputOverview();
}
function updateOutputOverview() {
    const reasons = [];
    if (simulationMode) reasons.push('模拟模式：只记录，不输出');
    if (connectionManager.state !== 'connected' || !char) {
        reasons.push(({ connecting: '正在连接设备', disconnecting: '正在断开设备', error: '连接失败，请重试' })[connectionManager.state] || '设备未连接');
    }
    if (isPanic()) reasons.push('紧急停止生效中，需先解除暂停');
    if (automationBusy || practiceChanging) reasons.push('正在保存规则或切换练习');
    if (!Coyote.sessionActive(currentPractice)) reasons.push('练习未开始或已结束');
    if (!chanA.checked && !chanB.checked) reasons.push('A/B 通道均已关闭');
    const armed = connectionManager.armed;
    const running = armed && !reasons.length && document.getElementById('zapNotify').style.display === 'block';
    const cooldown = Math.max(0, Math.ceil((lastZapTs + Coyote.clamp(cdSecondsInput.value, 0, 600) * 1000 - Date.now()) / 1000));
    let state = 'off', title = '输出未启用';
    if (armed) {
        state = reasons.length ? 'blocked' : running ? 'running' : cooldown ? 'blocked' : 'ready';
        title = reasons.length ? '输出已启用 · 暂不可输出' : running ? '正在发送输出' : cooldown ? '输出已启用 · 冷却中' : '输出已启用 · 等待触发';
    }
    const reason = reasons.length ? reasons.join('；') : !armed ? '设备已就绪，点击「启用输出」后才会实际输出。'
        : running ? '正在向设备发送指令；按 Esc 可紧急停止。'
        : cooldown ? `冷却剩余 ${cooldown} 秒，到期后保持启用。`
        : `通道 ${[chanA.checked && 'A', chanB.checked && 'B'].filter(Boolean).join(' / ')} · 可手动触发；自动输出仍遵守判题规则。`;
    document.getElementById('outputOverview').setAttribute('data-state', state);
    for (const [id, text] of [['outputOverviewTitle', title], ['outputOverviewReason', reason]]) {
        const element = document.getElementById(id);
        if (element.textContent !== text) element.textContent = text;
    }
}
async function connectBle(device, isCurrent = () => true) {
    const server = await device.gatt.connect();
    const check = () => { if (!isCurrent()) { server.disconnect(); throw new Error('连接已取消'); } };
    try {
        check();
        const service = await server.getPrimaryService('0000180c-0000-1000-8000-00805f9b34fb');
        check();
        const connection = await service.getCharacteristic('0000150a-0000-1000-8000-00805f9b34fb');
        check();
        await connection.writeValue(new Uint8Array([0xBF, 100, 100, 0, 0, 0, 0]));
        check();
        await connection.writeValue(buildPacket(0, 0, false, false));
        check();
        const notify = await service.getCharacteristic('0000150b-0000-1000-8000-00805f9b34fb');
        check();
        notify.addEventListener('characteristicvaluechanged', event => {
            if (!isCurrent()) return;
            const value = event.target.value;
            if (value.byteLength >= 4 && value.getUint8(0) === 0xB1) {
                document.getElementById('deviceStrength').textContent = `设备实际强度 A: ${value.getUint8(2)} / B: ${value.getUint8(3)}`;
            }
        });
        await notify.startNotifications();
        check();
        char = connection;
        await connectBattery(server, isCurrent);
        check();
    } catch (error) {
        if (isCurrent()) char = null;
        server.disconnect();
        throw error;
    }
}
document.getElementById('connectBtn').onclick = () => connectionManager.connect(() => {
    if (!navigator.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth，请使用桌面 Chrome / Edge');
    return navigator.bluetooth.requestDevice({ filters: [{ namePrefix: '47L121' }],
        optionalServices: ['0000180c-0000-1000-8000-00805f9b34fb', '0000180a-0000-1000-8000-00805f9b34fb'] });
}).catch(reportError);
document.getElementById('disconnectBtn').onclick = () => connectionManager.disconnect().catch(reportError);
document.getElementById('armOutputBtn').onclick = async () => {
    if (connectionManager.armed) { await cancelOutput(); return; }
    const generation = outputGeneration;
    const d = await chrome.storage.local.get(['zapSeq', 'automation', 'practice', 'panicUntil']);
    if (Coyote.automation(d.automation).simulation || simulationMode || Date.now() < (d.panicUntil || 0) || !Coyote.sessionActive(d.practice)) return;
    await featureRequest('CLEAR_IDLE_RETRY');
    await chrome.storage.local.set({ zapAck: d.zapSeq || 0 });
    if (generation !== outputGeneration) return;
    connectionManager.arm();
    updateConnectionUI();
};

// ---------- 郊狼 V3 协议 ----------
// B0 指令（20字节）真实布局：
//   byte0 = 0xB0
//   byte1 = 高4位序列号 | 低4位强度解读方式（bit3-2=A通道, bit1-0=B通道; 0b11=绝对设定）
//   byte2 = A通道强度, byte3 = B通道强度
//   byte4-7   = A通道波形频率(4段x25ms)
//   byte8-11  = A通道波形强度
//   byte12-15 = B通道波形频率
//   byte16-19 = B通道波形强度
// 一个包同时携带 AB 两通道的全部数据，双通道放电只需一个包，0x0F = AB都绝对设定。
function buildPacket(pA, pB, useA, useB) {
    const aInt = useA ? 100 : 0;   // 波形强度 0-100
    const bInt = useB ? 100 : 0;
    return new Uint8Array([
        0xB0, 0x0F, useA ? clampPower(pA) : 0, useB ? clampPower(pB) : 0,
        10, 10, 10, 10,
        aInt, aInt, aInt, aInt,
        10, 10, 10, 10,
        bInt, bInt, bInt, bInt
    ]);
}

// Writes are serialized; cancellation invalidates queued nonzero packets.
function clampPower(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))); }
let outputGeneration = 0;
let writeQueue = Promise.resolve();
let writeEpoch = 0;
let panicUntil = 0;
let lastZapTs = 0;
function isPanic() { return Date.now() < panicUntil; }
function writePacket(connection, packet, generation = null) {
    const epoch = writeEpoch;
    const job = writeQueue.then(async () => {
        if (epoch !== writeEpoch || char !== connection) return false;
        if (generation !== null && (generation !== outputGeneration || !connectionManager.armed || isPanic() || simulationMode || automationBusy || practiceChanging || !Coyote.sessionActive(currentPractice) || char !== connection)) return false;
        let timer;
        try {
            await Promise.race([connection.writeValue(packet), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('蓝牙写入超时，已关闭输出并断开连接')), 3000);
            })]);
            return true;
        } catch (error) {
            if (epoch === writeEpoch && char === connection) {
                // A timed-out native write cannot be cancelled: close GATT before reuse.
                // Do not await disconnect here; its stop request may be waiting on this job.
                char = null;
                connectionManager.disconnect().catch(reportError);
            }
            throw error;
        } finally { clearTimeout(timer); }
    });
    writeQueue = job.catch(() => {});
    return job;
}
function cancelOutput() {
    outputGeneration++;
    document.getElementById('zapNotify').style.display = 'none';
    connectionManager.disarm();
    updateConnectionUI();
    return char ? writePacket(char, buildPacket(0, 0, false, false)).catch(reportError) : Promise.resolve();
}
async function executeZap(power) {
    const connection = char, generation = outputGeneration, epoch = writeEpoch;
    const useA = chanA.checked, useB = chanB.checked;
    if (!connection || !connectionManager.armed || simulationMode || automationBusy || practiceChanging || isPanic() || !Coyote.sessionActive(currentPractice) || (!useA && !useB)) return false;
    document.getElementById('zapNotify').style.display = 'block';
    updateOutputOverview();
    let sent = false;
    try {
        for (let i = 0; i < 15; i++) {
            if (generation !== outputGeneration || !connectionManager.armed || isPanic() || simulationMode || automationBusy || practiceChanging || !Coyote.sessionActive(currentPractice) || char !== connection) break;
            sent = await writePacket(connection, buildPacket(power, power, useA, useB), generation) || sent;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return sent;
    } finally {
        if (epoch === writeEpoch) {
            try { await writePacket(connection, buildPacket(0, 0, false, false)); } catch (error) { reportError(error); }
            document.getElementById('zapNotify').style.display = 'none';
            updateOutputOverview();
        }
    }
}
// One lock across all extension control tabs, with durable event acknowledgement.
async function handleZap(manual = false) {
    await featureReady;
    const generation = outputGeneration;
    return navigator.locks.request('coyote-output', { ifAvailable: true }, async lock => {
        if (!lock) return false;
        const d = await chrome.storage.local.get(['zapSeq', 'zapAck', 'zapInfo', 'panicUntil', 'cfHandle', 'lastZapTs', 'automation', 'practice', 'cfg', 'policyRevision']);
        if (!manual && (!d.zapSeq || d.zapSeq <= (d.zapAck || 0))) return false;
        if (!manual) await chrome.storage.local.set({ zapAck: d.zapSeq });
        const info = manual ? { id: `manual-${Date.now()}`, verdict: '手动测试', subId: '--', combo: 1, ts: Date.now(), handle: d.cfHandle } : d.zapInfo;
        if (!info) return false;
        const record = (status, reason, power = info.power) => featureRequest('RECORD_OUTPUT', { entry: { ...info, status, reason, power } });
        if (generation !== outputGeneration) return false;
        panicUntil = d.panicUntil || 0;
        const policy = Coyote.automation(d.automation);
        if (policy.simulation || simulationMode || automationBusy || practiceChanging) return false;
        let reason = !connectionManager.armed ? '输出尚未启用' : Coyote.blocked(d, false);
        if (!reason && info.trigger === 'idle' && !d.cfg?.idleEnabled) reason = '无 AC 计时已关闭';
        if (reason === '冷却中') reason = `冷却剩余 ${Math.ceil(((d.lastZapTs || 0) + Coyote.clamp(d.cfg?.cdSeconds ?? 60, 0, 600) * 1000 - Date.now()) / 1000)} 秒`;
        if (!manual && !reason && info.ts < connectionManager.armedAt) reason = '事件早于本次启用，不补发';
        if (!reason && !char) reason = '蓝牙未连接，不补发';
        if (!manual && !reason && (info.handle !== d.cfHandle || Date.now() - info.ts > 15000)) reason = '事件已过期或账号已切换';
        if (!manual && !reason && ((info.policyRevision || 0) !== (d.policyRevision || 0) ||
            (info.sessionId || null) !== (d.practice?.active ? d.practice.id : null))) reason = '规则或练习会话已改变';
        if (reason) { await record('skipped', reason); return false; }
        const rule = policy.rules[info.verdictCode] || {};
        if (!manual && rule.action && rule.action !== 'output') { await record('skipped', '当前规则不允许输出'); return false; }
        const power = Coyote.power(d.cfg, rule, info.combo);
        if (power <= 0) { await record('skipped', '强度为 0', power); return false; }
        lastZapTs = Date.now();
        await chrome.storage.local.set({ lastZapTs });
        if (generation !== outputGeneration) return false;
        try {
            const sent = await executeZap(power);
            await record(sent ? 'executed' : 'skipped', sent ? '已发送；若被停止则已中断后续包' : '未发送输出', power);
            return sent;
        } catch (error) {
            await record('error', `发送失败：${error.message}`, power);
            throw error;
        }
    });
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cfg) {
        if (outputCfgChanged(changes.cfg.oldValue, changes.cfg.newValue)) cancelOutput();
        applyCfg(changes.cfg.newValue);
        updateOutputOverview();
        updateComboUIFromStorage();
    }
    if (changes.cfHandle) { cancelOutput(); loadAccount().catch(reportError); }
    if (changes.panicUntil) {
        panicUntil = changes.panicUntil.newValue || 0;
        if (isPanic()) cancelOutput();
        updatePanicUI();
    }
    if (changes.zapSeq && char && !simulationMode) handleZap().catch(reportError);
    if (changes.comboCount) updateComboUI(changes.comboCount.newValue || 0);
    if (changes.zapStats) document.getElementById('todayZaps').textContent = changes.zapStats.newValue?.count || 0;
    if (changes.monitorError?.newValue) reportError(new Error(changes.monitorError.newValue));
    if (changes.lastZapTs) { lastZapTs = changes.lastZapTs.newValue || 0; updateOutputOverview(); }
});
document.getElementById('testBtn').onclick = () => {
    if (simulationMode) { document.getElementById('simulateBtn').onclick(); return; }
    if (!char) { alert(t('connectFirst')); return; }
    handleZap(true).catch(reportError);
};
function updatePanicUI() {
    panicBtn.classList.toggle('active', isPanic());
    panicBtn.innerText = t(isPanic() ? 'panicActive' : 'panic');
}
panicBtn.onclick = async () => {
    panicUntil = isPanic() ? 0 : Date.now() + 3600000;
    cancelOutput();
    updatePanicUI();
    await chrome.storage.local.set({ panicUntil });
};
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !isPanic()) panicBtn.onclick().catch(reportError);
});
window.addEventListener('pagehide', () => { connectionManager.disconnect().catch(reportError); });
chrome.storage.local.get('panicUntil', d => { panicUntil = d.panicUntil || 0; updatePanicUI(); });
chrome.storage.local.get('lastZapTs', d => { lastZapTs = d.lastZapTs || 0; updateOutputOverview(); });
setInterval(updatePanicUI, 5000);
loadAccount().catch(reportError);

// Battery is an optional V3 characteristic. Read/notify failures do not break output connection.
async function connectBattery(server, isCurrent = () => true) {
    const label = document.getElementById('batteryLevel');
    label.textContent = '电量：读取中…';
    const show = value => {
        if (!isCurrent()) return;
        if (!value || value.byteLength < 1) { label.textContent = '电量：数据不可用'; return; }
        const percent = value.getUint8(0);
        if (percent > 100) { label.textContent = '电量：数据不可用'; return; }
        label.textContent = `电量：${percent}% · ${new Date().toLocaleTimeString()} 更新${percent <= 20 ? ' · 电量偏低' : ''}`;
        label.classList.toggle('battery-low', percent <= 20);
    };
    try {
        const service = await server.getPrimaryService('0000180a-0000-1000-8000-00805f9b34fb');
        const battery = await service.getCharacteristic('00001500-0000-1000-8000-00805f9b34fb');
        let readSucceeded = false;
        try { show(await battery.readValue()); readSucceeded = true; } catch { /* Try notifications. */ }
        battery.addEventListener('characteristicvaluechanged', event => show(event.target.value));
        try { await battery.startNotifications(); }
        catch { if (!readSucceeded) label.textContent = '电量：设备暂不支持读取'; }
    } catch { if (isCurrent()) label.textContent = '电量：不可用（连接仍可使用）'; }
}

setInterval(updateConnectionUI, 1000);
