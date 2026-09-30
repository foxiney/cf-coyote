// Automation settings, practice sessions and a bounded persistent event log.
let simulationMode = true;
let currentPractice = null;
let automationBusy = false;
let practiceChanging = false;
const ruleControls = new Map();
const simulationInput = document.getElementById('simulationMode');
const verdictSelect = document.getElementById('simulateVerdict');
for (const [code, label] of Object.entries(Coyote.verdicts)) {
    const row = document.createElement('div');
    row.className = 'rule-row';
    const name = document.createElement('label');
    name.textContent = label;
    name.htmlFor = `rule-${code}`;
    const action = document.createElement('select');
    action.id = `rule-${code}`;
    for (const [value, text] of [['output', '触发'], ['log', '仅记录'], ['ignore', '忽略']]) {
        const option = document.createElement('option');
        option.value = value; option.textContent = text; action.append(option);
    }
    const power = document.createElement('input');
    power.type = 'number'; power.min = '0'; power.max = '100'; power.step = '1';
    power.placeholder = '跟随基础'; power.className = 'num-input';
    power.setAttribute('aria-label', `${label} 基础强度`);
    row.append(name, action, power);
    document.getElementById('ruleList').append(row);
    ruleControls.set(code, { action, power });
    const option = document.createElement('option'); option.value = code; option.textContent = label;
    verdictSelect.append(option);
}
function applyAutomation(value) {
    const policy = Coyote.automation(value);
    simulationMode = policy.simulation;
    simulationInput.checked = simulationMode;
    for (const [code, controls] of ruleControls) {
        controls.action.value = policy.rules[code].action;
        controls.power.value = policy.rules[code].power ?? '';
    }
    const banner = document.getElementById('modeBanner');
    banner.textContent = simulationMode ? '模拟模式 · 只记录，不输出' : '实机模式 · 连接后需单独启用输出';
    banner.classList.toggle('live', !simulationMode);
}
async function featureRequest(action, fields = {}) {
    const response = await chrome.runtime.sendMessage({ action, ...fields });
    if (!response?.ok) throw new Error(response?.error || '后台请求失败');
    return response.result;
}
async function saveAutomation() {
    cancelOutput();
    if (automationBusy) return;
    automationBusy = true;
    const button = document.getElementById('saveRules');
    button.disabled = true; simulationInput.disabled = true;
    const rules = Object.fromEntries([...ruleControls].map(([code, controls]) => [code,
        { action: controls.action.value, power: controls.power.value }]));
    // Enter simulation locally immediately, before storage/network round trips.
    simulationMode = true;
    try {
        const value = { simulation: simulationInput.checked, rules };
        await featureRequest('SET_AUTOMATION', { value });
        applyAutomation(value);
        document.getElementById('ruleStatus').textContent = '模式与规则已保存；旧触发事件已清除。';
    } catch (error) {
        document.getElementById('ruleStatus').textContent = error.message;
        const { automation } = await chrome.storage.local.get('automation');
        applyAutomation(automation);
    } finally { automationBusy = false; button.disabled = false; simulationInput.disabled = false; }
}
simulationInput.onchange = () => saveAutomation().catch(reportError);
document.getElementById('saveRules').onclick = () => saveAutomation().catch(reportError);
document.getElementById('simulateBtn').onclick = async () => {
    const button = document.getElementById('simulateBtn'); button.disabled = true;
    try { await featureRequest('SIMULATE', { verdict: verdictSelect.value }); }
    catch (error) { reportError(error); }
    finally { button.disabled = false; }
};
function renderPractice() {
    const active = currentPractice?.enabled && Coyote.sessionActive(currentPractice);
    document.getElementById('sessionStatus').textContent = !currentPractice?.enabled ? '当前监控：全部新提交'
        : active ? `比赛 ${currentPractice.contestId} · 剩余 ${Math.ceil((currentPractice.endsAt - Date.now()) / 60000)} 分钟`
        : '练习已停止 · 自动触发关闭';
    document.getElementById('endPractice').disabled = !active;
}
async function changePractice(mode) {
    if (practiceChanging) return;
    practiceChanging = true;
    cancelOutput();
    const buttons = ['startPractice', 'endPractice', 'allSubmissions'].map(id => document.getElementById(id));
    buttons.forEach(button => { button.disabled = true; });
    try {
        currentPractice = await featureRequest('PRACTICE', { mode,
            contestId: document.getElementById('contestId').value,
            minutes: document.getElementById('practiceMinutes').value });
        renderPractice();
    } catch (error) { document.getElementById('sessionStatus').textContent = error.message; }
    finally { practiceChanging = false; buttons.forEach(button => { button.disabled = false; }); }
}
document.getElementById('practiceForm').onsubmit = event => { event.preventDefault(); changePractice('start').catch(reportError); };
document.getElementById('endPractice').onclick = () => changePractice('stop').catch(reportError);
document.getElementById('allSubmissions').onclick = () => changePractice('all').catch(reportError);
const LOG_LABELS = { simulated: '模拟', executed: '已输出', skipped: '跳过', ignored: '忽略',
    log: '记录', accepted: 'AC', pending: '待处理', error: '错误', session: '会话' };
function renderEventLog(entries = []) {
    const box = document.getElementById('zapLog');
    box.replaceChildren();
    if (!entries.length) { box.textContent = '暂无事件，选择一种判题并点击模拟测试。'; return; }
    for (const entry of entries) {
        const row = document.createElement('div'); row.className = 'ac-item';
        const power = entry.power == null ? '' : ` · 强度 ${entry.power}`;
        const stale = entry.status === 'pending' && Date.now() - entry.ts > 15000;
        row.textContent = `${new Date(entry.ts).toLocaleTimeString()} [${stale ? '已过期' : LOG_LABELS[entry.status] || entry.status}] ` +
            `${entry.verdict || ''}${entry.subId ? ' #' + entry.subId : ''}${power} · ${stale ? '未在有效期内处理，不补发' : entry.reason || ''}`;
        box.append(row);
    }
}
document.getElementById('clearLog').onclick = () => featureRequest('CLEAR_LOG').catch(reportError);
const featureReady = chrome.storage.local.get(['automation', 'practice', 'eventLog']).then(d => {
    applyAutomation(d.automation); currentPractice = d.practice; renderPractice(); renderEventLog(d.eventLog);
    if (d.practice?.contestId) document.getElementById('contestId').value = d.practice.contestId;
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.automation) { cancelOutput(); applyAutomation(changes.automation.newValue); }
    if (changes.practice) { cancelOutput(); currentPractice = changes.practice.newValue; renderPractice(); }
    if (changes.policyRevision) cancelOutput();
    if (changes.eventLog) renderEventLog(changes.eventLog.newValue);
});
setInterval(() => {
    if (currentPractice?.active && Date.now() >= currentPractice.endsAt) {
        currentPractice = { ...currentPractice, active: false };
        cancelOutput();
    }
    renderPractice();
}, 1000);
