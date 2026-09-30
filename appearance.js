// Presentation only: guide navigation never changes device or output settings.
(() => {
    const cards = [...document.querySelectorAll('[data-guide]')];
    const stage = document.getElementById('guideStage');
    const narrative = document.getElementById('guideNarrative');
    const descriptions = [
        '先验证你的 Codeforces 用户名，让新提交与练习数据在这里汇合。',
        '用模拟模式检查判题规则和预计强度。无需连接设备，也能先了解触发结果。',
        '连接设备后，输出默认关闭。准备好时再单独启用，紧急停止始终触手可及。'
    ];
    let index = 0, wheelAt = 0;
    function select(next) {
        index = (next + cards.length) % cards.length;
        cards.forEach((card, i) => { card.classList.toggle('active', i === index); card.setAttribute('aria-pressed', String(i === index)); });
        narrative.textContent = descriptions[index];
        narrative.classList.remove('switching');
        requestAnimationFrame(() => narrative.classList.add('switching'));
        document.getElementById('guideIndex').textContent = `0${index + 1} / 03`;
    }
    cards.forEach((card, i) => card.addEventListener('click', () => select(i)));
    document.getElementById('guidePrev').addEventListener('click', () => select(index - 1));
    document.getElementById('guideNext').addEventListener('click', () => select(index + 1));
    stage.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); select(index + (event.key === 'ArrowRight' ? 1 : -1));
    });
    // Do not steal ordinary page scrolling; wheel navigation is scoped to a focused stage.
    stage.addEventListener('wheel', event => {
        if (!stage.contains(document.activeElement) || Math.abs(event.deltaY) < 50) return;
        event.preventDefault();
        if (Date.now() - wheelAt < 450) return;
        wheelAt = Date.now(); select(index + Math.sign(event.deltaY));
    }, { passive: false });
    const status = document.getElementById('outputStatus');
    const connection = document.getElementById('connectionStatus');
    const panel = document.querySelector('.device-panel');
    function reflectStatus() {
        panel.classList.toggle('armed', connectionManager.armed);
        const badge = document.getElementById('deviceBadge');
        badge.textContent = { connected: '● 已连接', connecting: '◌ 连接中', disconnected: '○ 未连接', disconnecting: '◌ 断开中', error: '连接失败' }[connectionManager.state];
        badge.classList.toggle('connected', connectionManager.state === 'connected');
    }
    const observer = new MutationObserver(reflectStatus);
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    observer.observe(connection, { childList: true, characterData: true, subtree: true });
    reflectStatus();
})();
