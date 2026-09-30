// ONLY served by tests/preview_server.py. Never loaded by the extension.
const previewData = { cfHandle: 'PreviewUser', automation: { simulation: true }, cfg: { strength: 20, cdSeconds: 0 }, eventLog: [] };
const previewListeners = [];
window.chrome = {
    storage: {
        local: {
            async get(keys, callback) {
                const data = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, previewData[key]]));
                if (callback) queueMicrotask(() => callback(data));
                return data;
            },
            async set(values) {
                const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: previewData[key], newValue }]));
                Object.assign(previewData, values);
                previewListeners.forEach(fn => fn(changes, 'local'));
            }
        },
        onChanged: { addListener(fn) { previewListeners.push(fn); } }
    },
    runtime: { async sendMessage(message) {
        if (message.action === 'SET_CFG') await chrome.storage.local.set({ cfg: { ...previewData.cfg, ...message.value } });
        if (message.action === 'SET_AUTOMATION') await chrome.storage.local.set({ automation: message.value });
        if (message.action === 'RECORD_OUTPUT') await chrome.storage.local.set({ eventLog: [message.entry, ...previewData.eventLog] });
        if (message.action === 'CF_API') return { ok: true, result: { status: 'OK', result:
            message.method === 'user.info' ? [{ rank: 'expert', rating: 1800 }] : [] } };
        return { ok: true };
    } }
};
const previewEvents = new Map();
const previewGatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    disconnect() { this.connected = false; previewEvents.get('gattserverdisconnected')?.(); },
    async getPrimaryService(uuid) {
        return { async getCharacteristic() {
            return {
                async writeValue(packet) { document.getElementById('connectionStatus').textContent = `模拟设备已收到 ${packet.length} 字节`; },
                async readValue() { return new DataView(Uint8Array.of(82).buffer); },
                addEventListener() {}, async startNotifications() {}
            };
        } };
    }
};
Object.defineProperty(navigator, 'bluetooth', { value: { async requestDevice() {
    return { name: '47L121000 (模拟)', gatt: previewGatt,
        addEventListener: (name, fn) => previewEvents.set(name, fn),
        removeEventListener: name => previewEvents.delete(name) };
} } });
