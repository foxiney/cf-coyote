// The page only requests a refresh. Authoritative verdicts come from the configured account's API.
(() => {
    const panel = document.createElement('div');
    panel.id = 'coyote-debug-panel';
    panel.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;background:#1a1a2e;color:#ddd;padding:10px 14px;border-radius:8px;font:12px monospace;max-width:300px';
    document.body.append(panel);
    async function refresh() {
        try {
            if (!document.hidden) await chrome.runtime.sendMessage({ action: 'POLL_ACCOUNT' });
            const d = await chrome.storage.local.get(['cfHandle', 'comboCount', 'monitorError', 'automation', 'practice']);
            const practice = d.practice;
            const scope = practice?.enabled
                ? practice.active && Date.now() < practice.endsAt ? `比赛 ${practice.contestId}` : '练习已停止'
                : '全部新提交';
            const mode = d.automation?.simulation === false ? '实机' : '模拟';
            panel.textContent = !d.cfHandle ? '🐺 请在郊狼控制台设置 Codeforces 用户名'
                : `🐺 ${d.cfHandle} · ${mode} · ${scope} · 连败 ${d.comboCount || 0}${d.monitorError ? ' · 同步失败：' + d.monitorError : ''}`;
        } catch {
            panel.textContent = '🐺 插件已更新，请刷新页面';
            clearInterval(timer);
        }
    }
    const timer = setInterval(refresh, 15000);
    refresh();
})();
