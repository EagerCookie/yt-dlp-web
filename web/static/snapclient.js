/**
 * SnapCast browser client — connects to snapserver audio stream
 * via WebSocket binary protocol and plays PCM audio through Web Audio API.
 *
 * Architecture based on snapweb (https://github.com/badaix/snapweb):
 * - Pull-model playback with pre-filled rotating buffers
 * - NTP-style time synchronization
 * - Hard sync (>5ms) and soft sync (0.1-5ms)
 *
 * Only supports PCM s16le codec (snapserver must be configured with codec=pcm).
 */

// Message types
const MSG_CODEC = 1;
const MSG_WIRE_CHUNK = 2;
const MSG_SERVER_SETTINGS = 3;
const MSG_TIME = 4;
const MSG_HELLO = 5;

const HEADER_SIZE = 26;

// Playback constants (matching snapweb)
const BUFFER_DURATION_MS = 80;
const AUDIO_BUFFER_COUNT = 3;
const MIN_TIME_SYNCS = 3;

// ─── TimeProvider ───────────────────────────────────────────────────────────

class TimeProvider {
    constructor() {
        this._ctx = null;
        this._diffMedian = 0;  // server_time - wall_time (ms)
        this._diffs = [];
    }

    setAudioContext(ctx) {
        this._ctx = ctx;
    }

    /** Current wall-clock time in milliseconds (Date.now) */
    now() {
        return Date.now();
    }

    /** Convert wall-clock time (ms) to server time (ms) */
    serverTime(wallMs) {
        return wallMs + this._diffMedian;
    }

    /** Convert server time (ms) to wall-clock time (ms) */
    wallTime(serverMs) {
        return serverMs - this._diffMedian;
    }

    /** Convert wall-clock time (ms) to AudioContext time (seconds) */
    wallToCtx(wallMs) {
        if (!this._ctx) return 0;
        const nowWall = Date.now();
        const nowCtx = this._ctx.currentTime;
        return nowCtx + (wallMs - nowWall) / 1000;
    }

    /** Convert server time (ms) to AudioContext time (seconds) */
    serverToCtx(serverMs) {
        return this.wallToCtx(this.wallTime(serverMs));
    }

    /** Add a time offset sample (serverTime - clientTime, in ms) */
    addOffset(offsetMs) {
        this._diffs.push(offsetMs);
        if (this._diffs.length > 100) {
            this._diffs.shift();
        }
        const sorted = [...this._diffs].sort((a, b) => a - b);
        this._diffMedian = sorted[Math.floor(sorted.length / 2)];
    }

    get diffMs() { return this._diffMedian; }
    get syncCount() { return this._diffs.length; }
    get ready() { return this._diffs.length >= MIN_TIME_SYNCS; }
}

// ─── PcmChunk ───────────────────────────────────────────────────────────────

class PcmChunk {
    /**
     * @param {number} timestampMs - server timestamp of chunk start (ms)
     * @param {Float32Array[]} channels - decoded channel data [ch0, ch1, ...]
     * @param {number} sampleRate
     */
    constructor(timestampMs, channels, sampleRate) {
        this.timestampMs = timestampMs;
        this.channels = channels;
        this.sampleRate = sampleRate;
        this.idx = 0; // current read position in frames
    }

    /** Total frames in chunk */
    get totalFrames() {
        return this.channels[0].length;
    }

    /** Remaining unread frames */
    get remaining() {
        return this.totalFrames - this.idx;
    }

    /** Whether this chunk has been fully read */
    get empty() {
        return this.idx >= this.totalFrames;
    }

    /** Server time (ms) at current read position */
    startMs() {
        return this.timestampMs + (this.idx / this.sampleRate) * 1000;
    }

    /** Duration of remaining data in ms */
    durationMs() {
        return (this.remaining / this.sampleRate) * 1000;
    }

    /**
     * Read up to n frames from this chunk.
     * Returns array of Float32Arrays (one per channel), advances idx.
     */
    readFrames(n) {
        const count = Math.min(n, this.remaining);
        const result = [];
        for (let ch = 0; ch < this.channels.length; ch++) {
            result.push(this.channels[ch].subarray(this.idx, this.idx + count));
        }
        this.idx += count;
        return { data: result, frames: count };
    }

    /**
     * Skip n frames (for hard sync — dropping old data).
     */
    skipFrames(n) {
        this.idx = Math.min(this.idx + n, this.totalFrames);
    }
}

// ─── AudioStream ────────────────────────────────────────────────────────────

class AudioStream {
    constructor(timeProvider, sampleRate, channels) {
        this._timeProvider = timeProvider;
        this._sampleRate = sampleRate;
        this._channels = channels;
        this._chunks = [];
        this._bufferMs = 1000;
    }

    set bufferMs(val) { this._bufferMs = val; }
    get bufferMs() { return this._bufferMs; }

    /** Add a decoded PCM chunk to the stream */
    addChunk(chunk) {
        this._chunks.push(chunk);
        // Drop chunks older than 5s + bufferMs
        const maxAge = 5000 + this._bufferMs;
        const now = this._timeProvider.now();
        const serverNow = this._timeProvider.serverTime(now);
        while (this._chunks.length > 0) {
            const c = this._chunks[0];
            const age = serverNow - (c.startMs() + c.durationMs());
            if (age > maxAge) {
                this._chunks.shift();
            } else {
                break;
            }
        }
    }

    /**
     * Fill an AudioBuffer for playback at the given time.
     * Implements hard sync (>5ms) and soft sync (0.1-5ms).
     *
     * @param {AudioBuffer} buffer - buffer to fill
     * @param {number} playTimeMs - local playback time in ms
     * @returns {boolean} true if buffer was filled (at least partially)
     */
    getNextBuffer(buffer, playTimeMs) {
        const serverPlayTimeMs = this._timeProvider.serverTime(playTimeMs);
        const frames = buffer.length;

        // Remove fully-read chunks
        while (this._chunks.length > 0 && this._chunks[0].empty) {
            this._chunks.shift();
        }

        if (this._chunks.length === 0) {
            // Silence — no data available
            for (let ch = 0; ch < this._channels; ch++) {
                buffer.getChannelData(ch).fill(0);
            }
            return false;
        }

        const chunk = this._chunks[0];
        const age = serverPlayTimeMs - chunk.startMs();

        // Hard sync: age > 5ms — we're behind, skip samples
        if (age > 5) {
            const skipFrames = Math.floor((age / 1000) * this._sampleRate);
            let skipped = 0;
            while (skipped < skipFrames && this._chunks.length > 0) {
                const c = this._chunks[0];
                const toSkip = Math.min(skipFrames - skipped, c.remaining);
                c.skipFrames(toSkip);
                skipped += toSkip;
                if (c.empty) this._chunks.shift();
            }
            console.log(`[AudioStream] Hard sync: skipped ${skipped} frames (age: ${age.toFixed(1)}ms)`);
        }
        // Hard sync: age < -5ms — we're ahead, insert silence
        else if (age < -5) {
            const silenceFrames = Math.min(
                Math.floor((-age / 1000) * this._sampleRate),
                frames
            );
            for (let ch = 0; ch < this._channels; ch++) {
                buffer.getChannelData(ch).fill(0, 0, silenceFrames);
            }
            // Fill remaining from chunks
            if (silenceFrames < frames) {
                this._fillBuffer(buffer, silenceFrames, frames - silenceFrames, 0);
            }
            console.log(`[AudioStream] Hard sync: inserted ${silenceFrames} silence frames (age: ${age.toFixed(1)}ms)`);
            return true;
        }

        // Soft sync or no correction needed
        let softSyncFrames = 0;
        if (Math.abs(age) > 0.1 && Math.abs(age) <= 5) {
            // Calculate how many frames to add (negative age) or remove (positive age)
            softSyncFrames = Math.round((age / 1000) * this._sampleRate);
        }

        this._fillBuffer(buffer, 0, frames, softSyncFrames);
        return true;
    }

    /**
     * Fill buffer from chunks, optionally applying soft sync.
     * softSyncFrames > 0: drop that many frames (we're behind)
     * softSyncFrames < 0: duplicate that many frames (we're ahead)
     */
    _fillBuffer(buffer, offset, count, softSyncFrames) {
        const channelArrays = [];
        for (let ch = 0; ch < this._channels; ch++) {
            channelArrays.push(buffer.getChannelData(ch));
        }

        let written = offset;
        const end = offset + count;

        if (softSyncFrames > 0) {
            // Drop frames: read (count + softSyncFrames) from chunks, write count to buffer
            // Evenly distribute drops across the buffer
            const totalRead = count + softSyncFrames;
            const dropInterval = Math.floor(totalRead / softSyncFrames);
            let readCount = 0;
            let dropCount = 0;

            while (written < end && this._chunks.length > 0) {
                const c = this._chunks[0];
                if (c.empty) { this._chunks.shift(); continue; }

                const { data, frames } = c.readFrames(1);
                readCount++;

                if (dropCount < softSyncFrames && readCount % dropInterval === 0) {
                    // Drop this frame
                    dropCount++;
                    continue;
                }

                for (let ch = 0; ch < this._channels; ch++) {
                    channelArrays[ch][written] = data[ch][0];
                }
                written++;
                if (c.empty) this._chunks.shift();
            }
        } else if (softSyncFrames < 0) {
            // Duplicate frames: read (count + softSyncFrames) from chunks, write count to buffer
            const dupCount = -softSyncFrames;
            const totalRead = count - dupCount;
            const dupInterval = Math.max(1, Math.floor(totalRead / dupCount));
            let readTotal = 0;
            let duped = 0;

            while (written < end && this._chunks.length > 0) {
                const c = this._chunks[0];
                if (c.empty) { this._chunks.shift(); continue; }

                const { data, frames } = c.readFrames(1);
                readTotal++;

                for (let ch = 0; ch < this._channels; ch++) {
                    channelArrays[ch][written] = data[ch][0];
                }
                written++;

                // Duplicate this frame
                if (duped < dupCount && readTotal % dupInterval === 0 && written < end) {
                    for (let ch = 0; ch < this._channels; ch++) {
                        channelArrays[ch][written] = data[ch][0];
                    }
                    written++;
                    duped++;
                }

                if (c.empty) this._chunks.shift();
            }
        } else {
            // No correction — straight copy
            while (written < end && this._chunks.length > 0) {
                const c = this._chunks[0];
                if (c.empty) { this._chunks.shift(); continue; }

                const toRead = Math.min(end - written, c.remaining);
                const { data, frames } = c.readFrames(toRead);

                for (let ch = 0; ch < this._channels; ch++) {
                    channelArrays[ch].set(data[ch], written);
                }
                written += frames;
                if (c.empty) this._chunks.shift();
            }
        }

        // Fill remainder with silence if we ran out of data
        if (written < end) {
            for (let ch = 0; ch < this._channels; ch++) {
                channelArrays[ch].fill(0, written, end);
            }
        }
    }
}

// ─── SnapClient ─────────────────────────────────────────────────────────────

class SnapClient {
    constructor() {
        this._ws = null;
        this._ctx = null;
        this._gainNode = null;
        this._connected = false;
        this._playing = false;
        this._codec = null;
        this._sampleRate = 44100;
        this._channels = 2;
        this._bitsPerSample = 16;
        this._msgId = 0;
        this._id = this._generateId();
        this._onStateChange = null;

        // Time sync
        this._timeProvider = new TimeProvider();
        this._timeSyncInterval = null;

        // Audio stream
        this._stream = null;

        // Playback state (pull-model)
        this._playTime = 0;
        this._freeBuffers = [];
        this._bufferFrameCount = 0;
        this._bufferMs = 1000;
        this._latency = 0;

        // Auto-reconnect
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

        // Reset state for new connection
        this._timeProvider = new TimeProvider();
        this._stream = null;
        this._playTime = 0;
        this._freeBuffers = [];
        this._playing = false;

        try {
            this._ws = new WebSocket(url);
            this._ws.binaryType = 'arraybuffer';

            this._ws.onopen = () => {
                console.log('[SnapClient] Connected to', url);
                this._connected = true;
                this._reconnectDelay = 1000;
                this._sendHello();
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
        this._stream = null;
        this._freeBuffers = [];
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
        this._timeProvider.setAudioContext(this._ctx);
        this._latency = (this._ctx.baseLatency || 0) + (this._ctx.outputLatency || 0);

        // Calculate buffer frame count from duration
        this._bufferFrameCount = Math.ceil(this._sampleRate * BUFFER_DURATION_MS / 1000);

        // Initialize audio stream
        this._stream = new AudioStream(this._timeProvider, this._sampleRate, this._channels);
        this._stream.bufferMs = this._bufferMs;
    }

    // --- Pull-model playback ---

    /** Start playback with pre-filled buffers */
    _play() {
        if (!this._ctx || !this._stream || !this._timeProvider.ready) return;

        // _playTime is in AudioContext seconds domain
        this._playTime = this._ctx.currentTime + 0.1;

        for (let i = 0; i < AUDIO_BUFFER_COUNT; i++) {
            this._playNext();
        }
    }

    /** Fill and schedule next audio buffer */
    _playNext() {
        if (!this._ctx || !this._stream || !this._connected) return;

        // Get or create a buffer
        let buffer;
        if (this._freeBuffers.length > 0) {
            buffer = this._freeBuffers.pop();
        } else {
            buffer = this._ctx.createBuffer(this._channels, this._bufferFrameCount, this._sampleRate);
        }

        // Convert playTime (ctx seconds) to wall-clock ms for sync calculation
        // playTimeMs = wall-clock time when this buffer will actually be heard
        const nowCtx = this._ctx.currentTime;
        const nowWall = Date.now();
        const playWallMs = nowWall + (this._playTime - nowCtx + this._latency) * 1000;
        // Subtract bufferMs to get the server timestamp we should be playing
        const playTimeMs = playWallMs - this._bufferMs;

        // Fill the buffer from audio stream
        this._stream.getNextBuffer(buffer, playTimeMs);

        // Schedule playback
        const source = this._ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this._gainNode);
        source.onended = () => {
            // Recycle the buffer
            this._freeBuffers.push(buffer);
            // Schedule next
            this._playNext();
        };

        const now = this._ctx.currentTime;
        if (this._playTime < now) {
            // We fell behind, reset
            console.log(`[SnapClient] Playback fell behind by ${((now - this._playTime) * 1000).toFixed(0)}ms, resetting`);
            this._playTime = now + 0.01;
        }

        source.start(this._playTime);
        this._playTime += this._bufferFrameCount / this._sampleRate;

        if (!this._playing) {
            this._playing = true;
            this._notify();
        }
    }

    // --- Binary protocol ---

    _onMessage(data) {
        if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_SIZE) return;

        const view = new DataView(data);
        const type = view.getUint16(0, true);
        const sentSec = view.getInt32(6, true);
        const sentUsec = view.getInt32(10, true);

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
                this._handleTime(sentSec, sentUsec);
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
        if (!this._ctx || !this._stream) {
            this._initAudio();
        }

        const view = new DataView(buffer);
        const chunkSec = view.getInt32(26, true);
        const chunkUsec = view.getInt32(30, true);
        const chunkTimestampMs = chunkSec * 1000 + chunkUsec / 1000;

        if (!this._chunkLogCount) this._chunkLogCount = 0;
        if (this._chunkLogCount < 3) {
            console.log(`[SnapClient] CHUNK: sec=${chunkSec} usec=${chunkUsec} timestampMs=${chunkTimestampMs.toFixed(0)} Date.now=${Date.now()}`);
            this._chunkLogCount++;
        }

        // Decode PCM s16le to Float32
        const pcmData = new Int16Array(buffer.slice(38));
        const numSamples = pcmData.length;
        const numFrames = Math.floor(numSamples / this._channels);
        if (numFrames === 0) return;

        const channels = [];
        for (let ch = 0; ch < this._channels; ch++) {
            const channelData = new Float32Array(numFrames);
            for (let i = 0; i < numFrames; i++) {
                channelData[i] = pcmData[i * this._channels + ch] / 32768.0;
            }
            channels.push(channelData);
        }

        const chunk = new PcmChunk(chunkTimestampMs, channels, this._sampleRate);
        this._stream.addChunk(chunk);

        // Start playback once time sync is ready and we have data
        if (!this._playing && this._timeProvider.ready) {
            console.log(`[SnapClient] Time sync ready (${this._timeProvider.syncCount} samples, diff=${this._timeProvider.diffMs.toFixed(1)}ms), starting playback`);
            this._play();
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
                if (this._stream) {
                    this._stream.bufferMs = this._bufferMs;
                }
            }
            console.log('[SnapClient] Server settings:', settings);
        } catch (e) {
            console.warn('[SnapClient] Failed to parse server settings:', e);
        }
    }

    _handleTime(sentSec, sentUsec) {
        // Time sync: compute offset = serverTime - clientTime
        // sentSec/sentUsec = server's send timestamp (from header)
        const nowMs = Date.now();
        const sentMs = sentSec * 1000 + sentUsec / 1000;

        // offset = serverTime - clientTime (positive = server ahead)
        const offset = sentMs - nowMs;

        if (this._timeProvider.syncCount < 5) {
            console.log(`[SnapClient] TIME: sentMs=${sentMs.toFixed(0)} nowMs=${nowMs.toFixed(0)} offset=${offset.toFixed(1)}ms`);
        }

        this._timeProvider.addOffset(offset);

        this._sendTimeResponse(sentSec, sentUsec);

        // Start playback if time sync just became ready
        if (this._timeProvider.syncCount === MIN_TIME_SYNCS && !this._playing && this._stream && this._stream._chunks && this._stream._chunks.length > 0) {
            console.log(`[SnapClient] Time sync established, starting playback`);
            this._play();
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
