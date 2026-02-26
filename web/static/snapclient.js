/**
 * Minimal SnapCast browser client — connects to snapserver audio stream
 * via WebSocket binary protocol and plays PCM audio through Web Audio API.
 *
 * Only supports PCM s16le codec (snapserver must be configured with codec=pcm).
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

// Minimum time sync samples before we start playback
const MIN_TIME_SYNCS = 3;

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
        this._timeSyncCount = 0;   // number of time syncs received
        this._bufferMs = 1000;     // server buffer setting
        this._nextPlayTime = 0;    // next gapless play time on AudioContext timeline
        this._pendingChunks = [];  // buffered chunks while waiting for time sync
        this._id = this._generateId();
        this._onStateChange = null; // callback(connected: bool)

        // Auto-reconnect state
        this._autoReconnect = false;
        this._reconnectHost = null;
        this._reconnectPort = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 1000;
        this._volume = 100;
    }

    /** Connect to snapserver stream WebSocket (via HTTP port) */
    connect(host, port = 1780) {
        if (this._ws) this._closeWs();

        this._autoReconnect = true;
        this._reconnectHost = host;
        this._reconnectPort = port;
        this._reconnectDelay = 1000;
        this._clearReconnectTimer();

        this._doConnect(host, port);
    }

    _doConnect(host, port) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${host}:${port}/stream`;

        // Reset sync state for new connection
        this._timeOffsets = [];
        this._timeSyncCount = 0;
        this._serverTimeDiff = 0;
        this._nextPlayTime = 0;
        this._pendingChunks = [];

        try {
            this._ws = new WebSocket(url);
            this._ws.binaryType = 'arraybuffer';

            this._ws.onopen = () => {
                console.log('[SnapClient] Connected to', url);
                this._connected = true;
                this._reconnectDelay = 1000;
                this._sendHello();
                // Send first time sync immediately, don't wait 1s
                this._sendTimeRequest();
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
                this._nextPlayTime = 0;
                this._pendingChunks = [];
                this._notify();

                if (this._autoReconnect) {
                    this._scheduleReconnect();
                }
            };

            this._ws.onerror = (err) => {
                console.error('[SnapClient] WebSocket error', err);
            };
        } catch (e) {
            console.error('[SnapClient] Failed to connect:', e);
            if (this._autoReconnect) {
                this._scheduleReconnect();
            }
        }
    }

    _scheduleReconnect() {
        this._clearReconnectTimer();
        console.log(`[SnapClient] Reconnecting in ${this._reconnectDelay}ms...`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._autoReconnect) {
                this._doConnect(this._reconnectHost, this._reconnectPort);
            }
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _closeWs() {
        this._stopTimeSync();
        if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
        }
    }

    /** Disconnect and stop playback (manual — disables auto-reconnect) */
    disconnect() {
        this._autoReconnect = false;
        this._clearReconnectTimer();
        this._closeWs();
        if (this._ctx) {
            this._ctx.close().catch(() => {});
            this._ctx = null;
            this._gainNode = null;
        }
        this._connected = false;
        this._playing = false;
        this._timeOffsets = [];
        this._timeSyncCount = 0;
        this._nextPlayTime = 0;
        this._pendingChunks = [];
        this._notify();
    }

    /** Set volume (0-100) */
    setVolume(vol) {
        this._volume = Math.max(0, Math.min(100, vol));
        if (this._gainNode) {
            this._gainNode.gain.value = this._volume / 100;
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
        const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
        return `${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}`;
    }

    _initAudio() {
        if (this._ctx) return;
        this._ctx = new AudioContext({ sampleRate: this._sampleRate });
        this._gainNode = this._ctx.createGain();
        this._gainNode.gain.value = this._volume / 100;
        this._gainNode.connect(this._ctx.destination);
        if (this._ctx.state === 'suspended') {
            this._ctx.resume();
        }
    }

    /** Convert server timestamp (seconds) to AudioContext time */
    _serverToCtxTime(serverTimeSec) {
        const nowWall = Date.now() / 1000;
        const nowCtx = this._ctx.currentTime;
        const localWallTime = serverTimeSec - this._serverTimeDiff;
        return nowCtx + (localWallTime - nowWall);
    }

    get _timeSyncReady() {
        return this._timeSyncCount >= MIN_TIME_SYNCS;
    }

    // --- Binary protocol ---

    _onMessage(data) {
        if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_SIZE) return;

        const view = new DataView(data);
        const type = view.getUint16(0, true);
        const recvSec = view.getInt32(6, true);
        const recvUsec = view.getInt32(10, true);

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
                this._handleTime(recvSec, recvUsec);
                break;
        }
    }

    _handleCodec(buffer) {
        const view = new DataView(buffer);
        const codecSize = view.getUint32(26, true);
        const codecBytes = new Uint8Array(buffer, 30, codecSize);
        this._codec = new TextDecoder().decode(codecBytes);
        console.log('[SnapClient] Codec:', this._codec);

        if (this._codec !== 'pcm') {
            console.error('[SnapClient] Unsupported codec:', this._codec, '— snapserver must use codec=pcm');
            return;
        }

        this._initAudio();
    }

    _handleWireChunk(buffer) {
        if (this._codec !== 'pcm') return;
        if (!this._ctx || !this._gainNode) {
            this._initAudio();
        }

        // If time sync not yet established, buffer the chunk
        if (!this._timeSyncReady) {
            this._pendingChunks.push(buffer);
            return;
        }

        // If we have pending chunks (time sync just became ready), flush them
        if (this._pendingChunks.length > 0) {
            console.log(`[SnapClient] Time sync ready (${this._timeSyncCount} samples, diff=${this._serverTimeDiff.toFixed(4)}s), flushing ${this._pendingChunks.length} buffered chunks`);
            const pending = this._pendingChunks;
            this._pendingChunks = [];
            for (const chunk of pending) {
                this._playChunk(chunk);
            }
        }

        this._playChunk(buffer);
    }

    _playChunk(buffer) {
        const view = new DataView(buffer);
        const chunkSec = view.getInt32(26, true);
        const chunkUsec = view.getInt32(30, true);
        const chunkServerTime = chunkSec + chunkUsec / 1e6;

        const pcmData = new Int16Array(buffer.slice(38));
        const numSamples = pcmData.length;
        const numFrames = Math.floor(numSamples / this._channels);

        if (numFrames === 0) return;

        const audioBuffer = this._ctx.createBuffer(this._channels, numFrames, this._sampleRate);
        for (let ch = 0; ch < this._channels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            for (let i = 0; i < numFrames; i++) {
                channelData[i] = pcmData[i * this._channels + ch] / 32768.0;
            }
        }

        const now = this._ctx.currentTime;

        if (this._nextPlayTime <= now) {
            // Use server timestamp + bufferMs for sync-accurate start point
            const outputLatency = (this._ctx.baseLatency || 0) + (this._ctx.outputLatency || 0);
            const syncedStart = this._serverToCtxTime(chunkServerTime) + this._bufferMs / 1000 - outputLatency;
            this._nextPlayTime = Math.max(syncedStart, now + 0.01);
            console.log(`[SnapClient] Sync start: serverTime=${chunkServerTime.toFixed(3)} ctxStart=${this._nextPlayTime.toFixed(3)} ahead=${((this._nextPlayTime - now) * 1000).toFixed(0)}ms`);
        }

        const source = this._ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this._gainNode);
        source.start(this._nextPlayTime);
        this._nextPlayTime += audioBuffer.duration;

        if (!this._playing) {
            this._playing = true;
            this._notify();
        }
    }

    _handleServerSettings(buffer) {
        try {
            const view = new DataView(buffer);
            const jsonLen = view.getUint32(26, true);
            const jsonBytes = new Uint8Array(buffer, 30, jsonLen);
            const json = new TextDecoder().decode(jsonBytes);
            const settings = JSON.parse(json);
            if (settings.bufferMs !== undefined) {
                this._bufferMs = settings.bufferMs;
            }
            console.log('[SnapClient] Server settings:', settings);
        } catch (e) {
            console.warn('[SnapClient] Failed to parse server settings:', e);
        }
    }

    _handleTime(sentSec, sentUsec) {
        const nowMs = Date.now();
        const serverTimeMs = sentSec * 1000 + sentUsec / 1000;
        const offset = (serverTimeMs - nowMs) / 1000;
        this._timeOffsets.push(offset);
        if (this._timeOffsets.length > 100) {
            this._timeOffsets.shift();
        }
        const sorted = [...this._timeOffsets].sort((a, b) => a - b);
        this._serverTimeDiff = sorted[Math.floor(sorted.length / 2)];
        this._timeSyncCount++;

        this._sendTimeResponse(sentSec, sentUsec);

        // If time sync just became ready and we have pending chunks, process them
        if (this._timeSyncCount === MIN_TIME_SYNCS && this._pendingChunks.length > 0) {
            console.log(`[SnapClient] Time sync established, processing ${this._pendingChunks.length} pending chunks`);
            const pending = this._pendingChunks;
            this._pendingChunks = [];
            for (const chunk of pending) {
                this._playChunk(chunk);
            }
        }
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

        const payloadSize = 4 + encoded.length;
        const buf = new ArrayBuffer(HEADER_SIZE + payloadSize);
        const view = new DataView(buf);

        const now = Date.now() / 1000;
        const sec = Math.floor(now);
        const usec = Math.floor((now - sec) * 1e6);

        view.setUint16(0, MSG_HELLO, true);
        view.setUint16(2, ++this._msgId, true);
        view.setUint16(4, 0, true);
        view.setInt32(6, sec, true);
        view.setInt32(10, usec, true);
        view.setInt32(14, 0, true);
        view.setInt32(18, 0, true);
        view.setUint32(22, HEADER_SIZE + payloadSize, true);

        view.setUint32(26, encoded.length, true);
        new Uint8Array(buf, 30).set(encoded);

        this._ws.send(buf);
        console.log('[SnapClient] Sent Hello, ID:', this._id);
    }

    _sendTimeRequest() {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

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
        view.setUint32(22, HEADER_SIZE + 8, true);
        view.setInt32(26, 0, true);
        view.setInt32(30, 0, true);

        this._ws.send(buf);
    }

    _sendTimeResponse(serverSec, serverUsec) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

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
        view.setInt32(14, serverSec, true);
        view.setInt32(18, serverUsec, true);
        view.setUint32(22, HEADER_SIZE + 8, true);

        view.setInt32(26, 0, true);
        view.setInt32(30, 0, true);

        this._ws.send(buf);
    }

    // --- Time sync ---

    _startTimeSync() {
        this._timeSyncInterval = setInterval(() => {
            this._sendTimeRequest();
        }, 1000);
    }

    _stopTimeSync() {
        if (this._timeSyncInterval) {
            clearInterval(this._timeSyncInterval);
            this._timeSyncInterval = null;
        }
    }
}
