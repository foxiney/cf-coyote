// Shared policy: used by the service worker, console and regression tests.
globalThis.Coyote = (() => {
    const verdicts = {
        WRONG_ANSWER: 'WA · 答案错误', TIME_LIMIT_EXCEEDED: 'TLE · 超时',
        RUNTIME_ERROR: 'RE · 运行错误', COMPILATION_ERROR: 'CE · 编译错误',
        MEMORY_LIMIT_EXCEEDED: 'MLE · 内存超限', IDLENESS_LIMIT_EXCEEDED: 'ILE · 空闲超限',
        CHALLENGED: 'Hacked · 被 hack'
    };
    const clamp = (value, min, max, fallback = min) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    };
    function automation(value = {}) {
        const rules = {};
        for (const key of Object.keys(verdicts)) {
            const rule = value?.rules?.[key] || {};
            rules[key] = {
                action: ['output', 'log', 'ignore'].includes(rule.action) ? rule.action : 'output',
                power: rule.power === '' || rule.power == null ? null : Math.round(clamp(rule.power, 0, 100))
            };
        }
        return { simulation: value?.simulation !== false, rules };
    }
    function sessionActive(practice, now = Date.now()) {
        return !practice?.enabled || (practice.active && now >= practice.startedAt && now < practice.endsAt);
    }
    function includesSubmission(practice, submission, now = Date.now()) {
        if (!practice?.enabled) return true;
        return sessionActive(practice, now) && Number(submission.contestId ?? submission.problem?.contestId) === practice.contestId &&
            submission.creationTimeSeconds >= Math.floor(practice.startedAt / 1000) &&
            submission.creationTimeSeconds * 1000 < practice.endsAt;
    }
    function power(cfg = {}, rule = {}, combo = 1) {
        const base = rule.power ?? cfg.strength ?? 20;
        return Math.round(clamp(clamp(base, 0, 100) + clamp(cfg.comboStep ?? 5, 0, 20) *
            clamp((Number(combo) || 1) - 1, 0, 5), 0, 100));
    }
    function blocked(state, simulation, now = Date.now()) {
        if (!sessionActive(state.practice, now)) return '练习会话未开始或已结束';
        if (now < (state.panicUntil || 0)) return '紧急停止生效中';
        if (state.cfg?.useA === false && state.cfg?.useB === false) return '两个通道均关闭';
        const last = simulation ? state.lastSimTs : state.lastZapTs;
        if (now - (last || 0) < clamp(state.cfg?.cdSeconds ?? 60, 0, 600) * 1000) return '冷却中';
        return '';
    }
    return { verdicts, clamp, automation, sessionActive, includesSubmission, power, blocked };
})();
