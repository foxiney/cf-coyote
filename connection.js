// The Bluetooth lease lives for the whole connection, not for individual pulses.
class CoyoteConnection {
    constructor({ locks, onState, initialize, stop }) {
        Object.assign(this, { locks, onState, initialize, stop });
        this.state = 'disconnected';
        this.generation = 0;
        this.armed = false;
        this.armedAt = 0;
        this.device = null;
        this.releaseLease = null;
    }
    setState(state, message = '') {
        this.state = state;
        this.onState(state, message);
    }
    disarm() { this.armed = false; this.armedAt = 0; }
    async acquire() {
        return new Promise((resolve, reject) => {
            this.locks.request('coyote-bluetooth-connection', { ifAvailable: true }, async lock => {
                if (!lock) { reject(new Error('另一个控制台正在使用设备，请先在那里断开连接')); return; }
                await new Promise(release => { this.releaseLease = release; resolve(); });
            }).catch(reject);
        });
    }
    release() { this.releaseLease?.(); this.releaseLease = null; }
    async connect(chooseDevice) {
        if (['connecting', 'connected', 'disconnecting'].includes(this.state)) return false;
        const generation = ++this.generation;
        this.disarm();
        this.setState('connecting', '请选择郊狼 V3 主机');
        let device;
        try {
            // Call the chooser while the original click still has user activation.
            device = await chooseDevice();
            if (generation !== this.generation) return false;
            await this.acquire();
            if (generation !== this.generation) { this.release(); return false; }
            this.device = device;
            this.disconnectListener = () => this.lost(device, generation);
            device.addEventListener('gattserverdisconnected', this.disconnectListener);
            await this.initialize(device, () => generation === this.generation);
            if (generation !== this.generation) return false;
            this.setState('connected', '连接成功，输出尚未启用');
            return true;
        } catch (error) {
            if (generation !== this.generation) return false;
            await this.disconnect();
            this.setState(error.name === 'NotFoundError' ? 'disconnected' : 'error',
                error.name === 'NotFoundError' ? '已取消选择设备' : error.message);
            return false;
        }
    }
    lost(device, generation) {
        if (generation !== this.generation || device !== this.device) return;
        ++this.generation;
        this.disarm();
        device.removeEventListener('gattserverdisconnected', this.disconnectListener);
        this.device = null;
        this.release();
        this.setState('disconnected', '设备已断开；重连后需重新启用输出');
    }
    disconnect() {
        if (this.disconnectTask) return this.disconnectTask;
        this.disconnectTask = this.performDisconnect().finally(() => { this.disconnectTask = null; });
        return this.disconnectTask;
    }
    async performDisconnect() {
        ++this.generation;
        this.disarm();
        this.setState('disconnecting', '正在归零并断开');
        const device = this.device;
        if (device) device.removeEventListener('gattserverdisconnected', this.disconnectListener);
        let timer;
        try {
            await Promise.race([this.stop(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('归零写入超时，已强制断开连接')), 3000);
            })]);
        }
        finally {
            clearTimeout(timer);
            if (device) {
                device.gatt.disconnect();
            }
            this.device = null;
            this.release();
            this.setState('disconnected', '已断开，输出已关闭');
        }
    }
    arm() {
        if (this.state !== 'connected' || !this.device?.gatt.connected) throw new Error('设备未连接');
        this.armed = true;
        this.armedAt = Date.now();
    }
}
