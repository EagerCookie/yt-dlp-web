/**
 * Minimal SnapCast browser client — connects to snapserver audio stream
 * via WebSocket binary protocol and plays PCM audio through Web Audio API.
 *
 * Only supports PCM s16le codec (which is what our snapserver uses).
 *
 * Protocol reference: https://github.com/badaix/snapweb/blob/master/src/snapstream.ts
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

    /** Connect to snapserver stream WebSocket (via HTTP port) */
    connect(host, port = 1780) {
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
        // Note: snapcast deserialize swaps sent/received!
        // Wire offset 6 is read as "received", offset 14 as "sent"
        const recvSec = view.getInt32(6, true);   // server wrote this as "sent"
        const recvUsec = view.getInt32(10, true);
        const sentSec = view.getInt32(14, true);   // server wrote this as "received"
        const sentUsec = view.getInt32(18, true);
        const size = view.getUint32(22, true);

        switch (type) {
            case MSG_CODEC:
                this._handleCodec(data);
                break;
            case MSG_WIRE_CHUNK:
                this._handleWireChunk(data);
                break;
            case MSG_SERVER_SETTINGS:
                this._handleServerSettings(data);
                break;
            case MSG_TIME:
                // For time sync, we need the server's original send time
                // which is at wire offset 6 (recvSec after the swap)
                this._handleTime(recvSec, recvUsec, id);
                break;
        }
    }

    _handleCodec(buffer) {
        const view = new DataView(buffer);
        // Offset 26: uint32 codec string length
        const codecSize = view.getUint32(26, true);
        const codecBytes = new Uint8Array(buffer, 30, codecSize);
        this._codec = new TextDecoder().decode(codecBytes);
        console.log('[SnapClient] Codec:', this._codec);

        if (this._codec === 'pcm') {
            // Parse PCM header after codec string
            const headerOffset = 30 + codecSize;
            const headerSize = view.getUint32(headerOffset, true);
            // PCM header is optional, we use known settings
        }

        this._initAudio();
    }

    _handleWireChunk(buffer) {
        if (!this._ctx || !this._gainNode) {
            this._initAudio();
        }

        const view = new DataView(buffer);
        // Offset 26: timestamp sec (int32)
        // Offset 30: timestamp usec (int32)
        // Offset 34: payload size (uint32) — present but we skip it
        // Offset 38+: raw PCM data
        const pcmData = new Int16Array(buffer.slice(38));
        const numSamples = pcmData.length;
        const numFrames = Math.floor(numSamples / this._channels);

        if (numFrames === 0) return;

        // Create audio buffer
        const audioBuffer = this._ctx.createBuffer(this._channels, numFrames, this._sampleRate);

        // Deinterleave and convert Int16 → Float32
        for (let ch = 0; ch < this._channels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < numFrames; i++) {
                channelData[i] = pcmData[i * this._channels + ch] / 32768.0;
            }
        }

        // Schedule playback
        const source = this._ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this._gainNode);

        const now = this._ctx.currentTime;
        if (this._playTime <= now) {
            // First chunk or fallen behind — start from now with small buffer
            this._playTime = now + 0.05;
        }

        source.start(this._playTime);
        this._playTime += audioBuffer.duration;

        if (!this._playing) {
            this._playing = true;
            this._notify();
        }
    }

    _handleServerSettings(buffer) {
        try {
            const view = new DataView(buffer);
            // Offset 26: uint32 JSON string length
            const jsonLen = view.getUint32(26, true);
            // Offset 30: JSON string bytes
            const jsonBytes = new Uint8Array(buffer, 30, jsonLen);
            const json = new TextDecoder().decode(jsonBytes);
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
            console.warn('[SnapClient] Failed to parse server settings:', e);
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

    _sendHello() {
        const jsonStr = JSON.stringify({
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
        const encoded = new TextEncoder().encode(jsonStr);

        // Hello payload = uint32 length prefix + JSON bytes
        const payloadSize = 4 + encoded.length;
        const buf = new ArrayBuffer(HEADER_SIZE + payloadSize);
        const view = new DataView(buf);

        const now = Date.now() / 1000;
        const sec = Math.floor(now);
        const usec = Math.floor((now - sec) * 1e6);

        // Header
        view.setUint16(0, MSG_HELLO, true);
        view.setUint16(2, ++this._msgId, true);
        view.setUint16(4, 0, true);
        view.setInt32(6, sec, true);
        view.setInt32(10, usec, true);
        view.setInt32(14, 0, true);
        view.setInt32(18, 0, true);
        view.setUint32(22, HEADER_SIZE + payloadSize, true);  // size = total message size

        // Payload: uint32 json length + json bytes
        view.setUint32(26, encoded.length, true);
        new Uint8Array(buf, 30).set(encoded);

        this._ws.send(buf);
        console.log('[SnapClient] Sent Hello, ID:', this._id);
    }

    _sendTimeResponse(serverSec, serverUsec) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

        const buf = new ArrayBuffer(HEADER_SIZE + 8);
        const view = new DataView(buf);

        const now = Date.now() / 1000;
        const sec = Math.floor(now);
        const usec = Math.floor((now - sec) * 1e6);

        // Header — note: in snapcast wire format, offset 6 = sent, offset 14 = received
        // but deserialize swaps them (offset 6 → received, offset 14 → sent)
        view.setUint16(0, MSG_TIME, true);
        view.setUint16(2, ++this._msgId, true);
        view.setUint16(4, 0, true);
        view.setInt32(6, sec, true);            // wire "sent" = our send time
        view.setInt32(10, usec, true);
        view.setInt32(14, serverSec, true);     // wire "received" = server's original time
        view.setInt32(18, serverUsec, true);
        view.setUint32(22, HEADER_SIZE + 8, true);  // size = total message size (34)

        // Payload: latency (zeros)
        view.setInt32(26, 0, true);
        view.setInt32(30, 0, true);

        this._ws.send(buf);
    }

    // --- Time sync ---

    _startTimeSync() {
        this._timeSyncInterval = setInterval(() => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) {
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
                view.setUint32(22, HEADER_SIZE + 8, true);  // size = total (34)
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
