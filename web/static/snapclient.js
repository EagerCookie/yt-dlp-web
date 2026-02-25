/**
 * Minimal SnapCast browser client — connects to snapserver audio stream
 * via WebSocket binary protocol and plays PCM audio through Web Audio API.
 *
 * Only supports PCM s16le codec (which is what our snapserver uses).
 */

// Message types
const MSG_CODEC = 1;
const MSG_WIRE_CHUNK = 2;
const MSG_SERVER_SETTINGS = 3;
const MSG_TIME = 4;
const MSG_HELLO = 5;

const HEADER_SIZE = 26;

class SnapClient {
    constructor() {
        this._ws = null;
        this._ctx = null;          // AudioContext
        this._gainNode = null;     // GainNode for volume
        this._connected = false;
        this._playing = false;
        this._codec = null;        // codec name from server
        this._sampleRate = 44100;
        this._channels = 2;
        this._bitsPerSample = 16;
        this._msgId = 0;
        this._serverTimeDiff = 0;  // server_time - client_time (seconds)
        this._timeOffsets = [];    // for median calculation
        this._bufferMs = 1000;     // server buffer setting
        this._playTime = 0;       // next scheduled play time
        this._id = this._generateId();
        this._onStateChange = null; // callback(connected: bool)
    }

    /** Connect to snapserver stream WebSocket */
    connect(host, port = 1704) {
        if (this._ws) this.disconnect();

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${host}:${port}/stream`;

        try {
            this._ws = new WebSocket(url);
            this._ws.binaryType = 'arraybuffer';

            this._ws.onopen = () => {
                console.log('[SnapClient] Connected to', url);
                this._connected = true;
                this._sendHello();
                this._startTimeSync();
                this._notify();
            };

            this._ws.onmessage = (event) => {
                this._onMessage(event.data);
            };

            this._ws.onclose = () => {
                console.log('[SnapClient] Disconnected');
                this._connected = false;
                this._playing = false;
                this._stopTimeSync();
                this._notify();
            };

            this._ws.onerror = (err) => {
                console.error('[SnapClient] WebSocket error', err);
            };
        } catch (e) {
            console.error('[SnapClient] Failed to connect:', e);
        }
    }

    /** Disconnect and stop playback */
    disconnect() {
        this._stopTimeSync();
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        if (this._ctx) {
            this._ctx.close().catch(() => {});
            this._ctx = null;
            this._gainNode = null;
        }
        this._connected = false;
        this._playing = false;
        this._playTime = 0;
        this._timeOffsets = [];
        this._notify();
    }

    /** Set volume (0-100) */
    setVolume(vol) {
        if (this._gainNode) {
            this._gainNode.gain.value = Math.max(0, Math.min(1, vol / 100));
        }
    }

    get connected() { return this._connected; }
    get playing() { return this._playing; }

    set onStateChange(fn) { this._onStateChange = fn; }

    // --- Private ---

    _notify() {
        if (this._onStateChange) this._onStateChange(this._connected);
    }

    _generateId() {
        // Random MAC-like ID for this browser client
        const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
        return `${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}`;
    }

    _initAudio() {
        if (this._ctx) return;
        this._ctx = new AudioContext({ sampleRate: this._sampleRate });
        this._gainNode = this._ctx.createGain();
        this._gainNode.connect(this._ctx.destination);
        // Resume context (required for user gesture policy)
        if (this._ctx.state === 'suspended') {
            this._ctx.resume();
        }
    }

    // --- Binary protocol ---

    _onMessage(data) {
        if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_SIZE) return;

        const view = new DataView(data);
        const type = view.getUint16(0, true);
        const id = view.getUint16(2, true);
        const refersTo = view.getUint16(4, true);
        const sentSec = view.getInt32(6, true);
        const sentUsec = view.getInt32(10, true);
        const recvSec = view.getInt32(14, true);
        const recvUsec = view.getInt32(18, true);
        const size = view.getUint32(22, true);

        const payload = data.slice(HEADER_SIZE);

        switch (type) {
            case MSG_CODEC:
                this._handleCodec(payload);
                break;
            case MSG_WIRE_CHUNK:
                this._handleWireChunk(payload);
                break;
            case MSG_SERVER_SETTINGS:
                this._handleServerSettings(payload);
                break;
            case MSG_TIME:
                this._handleTime(sentSec, sentUsec, id);
                break;
        }
    }

    _handleCodec(payload) {
        const view = new DataView(payload);
        const codecSize = view.getUint32(0, true);
        const codecBytes = new Uint8Array(payload, 4, codecSize);
        this._codec = new TextDecoder().decode(codecBytes);
        console.log('[SnapClient] Codec:', this._codec);

        if (this._codec === 'pcm') {
            // Parse PCM header from payload after codec string
            const headerSize = view.getUint32(4 + codecSize, true);
            if (headerSize >= 12) {
                const headerData = new DataView(payload, 8 + codecSize);
                // PCM header: typically contains sample format info
                // We'll use our known settings: 44100 Hz, 16-bit, 2 channels
            }
        }

        this._initAudio();
    }

    _handleWireChunk(payload) {
        if (!this._ctx || !this._gainNode) {
            this._initAudio();
        }

        const view = new DataView(payload);
        // Timestamp: sec + usec
        const chunkSec = view.getInt32(0, true);
        const chunkUsec = view.getInt32(4, true);

        // PCM data starts after timestamp (8 bytes)
        const pcmData = new Int16Array(payload.slice(8));
        const numSamples = pcmData.length;
        const numFrames = Math.floor(numSamples / this._channels);

        if (numFrames === 0) return;

        // Create audio buffer
        const buffer = this._ctx.createBuffer(this._channels, numFrames, this._sampleRate);

        // Deinterleave and convert Int16 → Float32
        for (let ch = 0; ch < this._channels; ch++) {
            const channelData = buffer.getChannelData(ch);
            for (let i = 0; i < numFrames; i++) {
                channelData[i] = pcmData[i * this._channels + ch] / 32768.0;
            }
        }

        // Schedule playback
        const source = this._ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this._gainNode);

        const now = this._ctx.currentTime;
        if (this._playTime <= now) {
            // First chunk or fallen behind — start from now with small buffer
            this._playTime = now + 0.05;
        }

        source.start(this._playTime);
        this._playTime += buffer.duration;

        if (!this._playing) {
            this._playing = true;
            this._notify();
        }
    }

    _handleServerSettings(payload) {
        try {
            const json = new TextDecoder().decode(payload);
            const settings = JSON.parse(json);
            if (settings.bufferMs !== undefined) {
                this._bufferMs = settings.bufferMs;
            }
            if (settings.volume !== undefined) {
                this.setVolume(settings.volume);
            }
            if (settings.muted) {
                this.setVolume(0);
            }
            console.log('[SnapClient] Server settings:', settings);
        } catch (e) {
            // ignore parse errors
        }
    }

    _handleTime(sentSec, sentUsec, msgId) {
        // Calculate time offset between server and client
        const now = Date.now() / 1000;
        const serverTime = sentSec + sentUsec / 1e6;
        const offset = serverTime - now;
        this._timeOffsets.push(offset);
        if (this._timeOffsets.length > 60) {
            this._timeOffsets.shift();
        }
        // Use median offset
        const sorted = [...this._timeOffsets].sort((a, b) => a - b);
        this._serverTimeDiff = sorted[Math.floor(sorted.length / 2)];

        // Send time response
        this._sendTimeResponse(sentSec, sentUsec);
    }

    // --- Send messages ---

    _buildMessage(type, payload) {
        const payloadBytes = (typeof payload === 'string')
            ? new TextEncoder().encode(payload)
            : payload;
        const size = payloadBytes.byteLength;
        const buf = new ArrayBuffer(HEADER_SIZE + size);
        const view = new DataView(buf);

        const now = Date.now() / 1000;
        const sec = Math.floor(now);
        const usec = Math.floor((now - sec) * 1e6);

        view.setUint16(0, type, true);          // type
        view.setUint16(2, ++this._msgId, true); // id
        view.setUint16(4, 0, true);             // refersTo
        view.setInt32(6, sec, true);            // sent.sec
        view.setInt32(10, usec, true);          // sent.usec
        view.setInt32(14, 0, true);             // received.sec
        view.setInt32(18, 0, true);             // received.usec
        view.setUint32(22, size, true);         // size

        new Uint8Array(buf, HEADER_SIZE).set(new Uint8Array(payloadBytes.buffer || payloadBytes));
        return buf;
    }

    _sendHello() {
        const hello = JSON.stringify({
            MAC: this._id,
            HostName: 'Browser',
            Version: '0.27.0',
            ClientName: 'yt-dlp-web',
            OS: navigator.platform || 'browser',
            Arch: 'web',
            Instance: 1,
            ID: this._id,
            SnapStreamProtocolVersion: 2,
        });
        const msg = this._buildMessage(MSG_HELLO, hello);
        this._ws.send(msg);
    }

    _sendTimeResponse(serverSec, serverUsec) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

        const buf = new ArrayBuffer(HEADER_SIZE + 8);
        const view = new DataView(buf);

        const now = Date.now() / 1000;
        const sec = Math.floor(now);
        const usec = Math.floor((now - sec) * 1e6);

        view.setUint16(0, MSG_TIME, true);      // type
        view.setUint16(2, ++this._msgId, true); // id
        view.setUint16(4, 0, true);             // refersTo
        view.setInt32(6, sec, true);            // sent.sec (client send time)
        view.setInt32(10, usec, true);          // sent.usec
        view.setInt32(14, serverSec, true);     // received.sec (server's sent time)
        view.setInt32(18, serverUsec, true);    // received.usec
        view.setUint32(22, 8, true);            // size (8 bytes payload)

        // Payload: latency placeholder (zeros)
        view.setInt32(26, 0, true);
        view.setInt32(30, 0, true);

        this._ws.send(buf);
    }

    // --- Time sync ---

    _startTimeSync() {
        this._timeSyncInterval = setInterval(() => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                // Send empty time request
                const buf = new ArrayBuffer(HEADER_SIZE + 8);
                const view = new DataView(buf);
                const now = Date.now() / 1000;
                const sec = Math.floor(now);
                const usec = Math.floor((now - sec) * 1e6);

                view.setUint16(0, MSG_TIME, true);
                view.setUint16(2, ++this._msgId, true);
                view.setUint16(4, 0, true);
                view.setInt32(6, sec, true);
                view.setInt32(10, usec, true);
                view.setInt32(14, 0, true);
                view.setInt32(18, 0, true);
                view.setUint32(22, 8, true);
                view.setInt32(26, 0, true);
                view.setInt32(30, 0, true);

                this._ws.send(buf);
            }
        }, 1000);
    }

    _stopTimeSync() {
        if (this._timeSyncInterval) {
            clearInterval(this._timeSyncInterval);
            this._timeSyncInterval = null;
        }
    }
}
