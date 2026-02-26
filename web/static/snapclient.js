/**
 * SnapCast browser client — direct port of snapweb's snapstream.ts to JavaScript.
 * Source: https://github.com/badaix/snapweb/blob/master/src/snapstream.ts
 *
 * Stripped: FlacDecoder, OpusDecoder, standardized-audio-context, React deps.
 * Added: SnapClient wrapper for app.js compatibility + auto-reconnect.
 */

// ─── Tv (timestamp value) ──────────────────────────────────────────────────

class Tv {
    constructor(sec = 0, usec = 0) {
        this.sec = sec;
        this.usec = usec;
    }

    setMilliseconds(ms) {
        this.sec = Math.floor(ms / 1000);
        this.usec = Math.floor(ms * 1000) % 1000000;
    }

    getMilliseconds() {
        return this.sec * 1000 + this.usec / 1000;
    }
}

// ─── BaseMessage ────────────────────────────────────────────────────────────
// IMPORTANT: serialize/deserialize have an intentional perspective swap:
//   serialize:   offset 6 = sent,     offset 14 = received
//   deserialize: offset 6 = received, offset 14 = sent

class BaseMessage {
    constructor() {
        this.type = 0;
        this.id = 0;
        this.refersTo = 0;
        this.received = new Tv();
        this.sent = new Tv();
        this.size = 0;
    }

    deserialize(buffer) {
        const view = new DataView(buffer);
        this.type = view.getUint16(0, true);
        this.id = view.getUint16(2, true);
        this.refersTo = view.getUint16(4, true);
        this.received = new Tv(view.getInt32(6, true), view.getInt32(10, true));
        this.sent = new Tv(view.getInt32(14, true), view.getInt32(18, true));
        this.size = view.getUint32(22, true);
    }

    serialize() {
        this.size = 26 + this.getSize();
        const buffer = new ArrayBuffer(this.size);
        const view = new DataView(buffer);
        view.setUint16(0, this.type, true);
        view.setUint16(2, this.id, true);
        view.setUint16(4, this.refersTo, true);
        view.setInt32(6, this.sent.sec, true);
        view.setInt32(10, this.sent.usec, true);
        view.setInt32(14, this.received.sec, true);
        view.setInt32(18, this.received.usec, true);
        view.setUint32(22, this.size, true);
        return buffer;
    }

    getSize() {
        return 0;
    }
}

// ─── TimeMessage ────────────────────────────────────────────────────────────

class TimeMessage extends BaseMessage {
    constructor(buffer) {
        super();
        this.latency = new Tv();
        if (buffer) this.deserialize(buffer);
        this.type = 4;
    }

    deserialize(buffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        this.latency = new Tv(view.getInt32(26, true), view.getInt32(30, true));
    }

    serialize() {
        const buffer = super.serialize();
        const view = new DataView(buffer);
        view.setInt32(26, this.latency.sec, true);
        view.setInt32(30, this.latency.usec, true);
        return buffer;
    }

    getSize() {
        return 8;
    }
}

// ─── JsonMessage ────────────────────────────────────────────────────────────

class JsonMessage extends BaseMessage {
    constructor(buffer) {
        super();
        this.json = null;
        if (buffer) this.deserialize(buffer);
    }

    deserialize(buffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        const size = view.getUint32(26, true);
        const decoder = new TextDecoder();
        this.json = JSON.parse(decoder.decode(buffer.slice(30, 30 + size)));
    }

    serialize() {
        const buffer = super.serialize();
        const view = new DataView(buffer);
        const jsonStr = JSON.stringify(this.json);
        view.setUint32(26, jsonStr.length, true);
        const encoder = new TextEncoder();
        const encoded = encoder.encode(jsonStr);
        for (let i = 0; i < encoded.length; ++i)
            view.setUint8(30 + i, encoded[i]);
        return buffer;
    }

    getSize() {
        const encoder = new TextEncoder();
        const encoded = encoder.encode(JSON.stringify(this.json));
        return encoded.length + 4;
    }
}

// ─── HelloMessage ───────────────────────────────────────────────────────────

class HelloMessage extends JsonMessage {
    constructor(buffer) {
        super(buffer);
        this.type = 5;
        this.mac = '';
        this.hostname = '';
        this.version = '0.28.0';
        this.clientName = 'yt-dlp-web';
        this.os = '';
        this.arch = 'web';
        this.instance = 1;
        this.uniqueId = '';
        this.snapStreamProtocolVersion = 2;
    }

    serialize() {
        this.json = {
            MAC: this.mac,
            HostName: this.hostname,
            Version: this.version,
            ClientName: this.clientName,
            OS: this.os,
            Arch: this.arch,
            Instance: this.instance,
            ID: this.uniqueId,
            SnapStreamProtocolVersion: this.snapStreamProtocolVersion,
        };
        return super.serialize();
    }
}

// ─── ServerSettingsMessage ──────────────────────────────────────────────────

class ServerSettingsMessage extends JsonMessage {
    constructor(buffer) {
        super(buffer);
        this.type = 3;
        this.bufferMs = 0;
        this.latency = 0;
        this.volumePercent = 0;
        this.muted = false;
        if (buffer) this._parse();
    }

    _parse() {
        if (!this.json) return;
        this.bufferMs = this.json.bufferMs || 0;
        this.latency = this.json.latency || 0;
        this.volumePercent = this.json.volume || 0;
        this.muted = !!this.json.muted;
    }
}

// ─── CodecMessage ───────────────────────────────────────────────────────────

class CodecMessage extends BaseMessage {
    constructor(buffer) {
        super();
        this.codec = '';
        this.payload = new ArrayBuffer(0);
        if (buffer) this.deserialize(buffer);
        this.type = 1;
    }

    deserialize(buffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        const codecSize = view.getInt32(26, true);
        const decoder = new TextDecoder('utf-8');
        this.codec = decoder.decode(buffer.slice(30, 30 + codecSize));
        const payloadSize = view.getInt32(30 + codecSize, true);
        this.payload = buffer.slice(34 + codecSize, 34 + codecSize + payloadSize);
    }
}

// ─── SampleFormat ───────────────────────────────────────────────────────────

class SampleFormat {
    constructor() {
        this.rate = 48000;
        this.channels = 2;
        this.bits = 16;
    }

    msRate() {
        return this.rate / 1000;
    }

    frameSize() {
        return this.channels * this.sampleSize();
    }

    sampleSize() {
        if (this.bits === 24) return 4;
        return this.bits / 8;
    }
}

// ─── PcmChunkMessage ────────────────────────────────────────────────────────

class PcmChunkMessage extends BaseMessage {
    constructor(buffer, sampleFormat) {
        super();
        this.timestamp = new Tv();
        this.payload = new ArrayBuffer(0);
        this.idx = 0;
        this.sampleFormat = sampleFormat;
        if (buffer) this.deserialize(buffer);
        this.type = 2;
    }

    deserialize(buffer) {
        super.deserialize(buffer);
        const view = new DataView(buffer);
        this.timestamp = new Tv(view.getInt32(26, true), view.getInt32(30, true));
        this.payload = buffer.slice(38);
    }

    readFrames(frames) {
        const frameSize = this.sampleFormat.frameSize();
        let frameCnt = frames;
        if (this.idx + frames > this.payloadSize() / frameSize)
            frameCnt = (this.payloadSize() / frameSize) - this.idx;
        const begin = this.idx * frameSize;
        this.idx += frameCnt;
        const end = begin + frameCnt * frameSize;
        return this.payload.slice(begin, end);
    }

    getFrameCount() {
        return this.payloadSize() / this.sampleFormat.frameSize();
    }

    isEndOfChunk() {
        return this.idx >= this.getFrameCount();
    }

    startMs() {
        return this.timestamp.getMilliseconds() + 1000 * (this.idx / this.sampleFormat.rate);
    }

    duration() {
        return 1000 * ((this.getFrameCount() - this.idx) / this.sampleFormat.rate);
    }

    payloadSize() {
        return this.payload.byteLength;
    }

    clearPayload() {
        this.payload = new ArrayBuffer(0);
    }

    addPayload(buffer) {
        const payload = new ArrayBuffer(this.payload.byteLength + buffer.byteLength);
        const view = new DataView(payload);
        const viewOld = new DataView(this.payload);
        const viewNew = new DataView(buffer);
        for (let i = 0; i < viewOld.byteLength; ++i)
            view.setInt8(i, viewOld.getInt8(i));
        for (let i = 0; i < viewNew.byteLength; ++i)
            view.setInt8(i + viewOld.byteLength, viewNew.getInt8(i));
        this.payload = payload;
    }
}

// ─── PcmDecoder ─────────────────────────────────────────────────────────────

class PcmDecoder {
    setHeader(buffer) {
        const sampleFormat = new SampleFormat();
        const view = new DataView(buffer);
        sampleFormat.channels = view.getUint16(22, true);
        sampleFormat.rate = view.getUint32(24, true);
        sampleFormat.bits = view.getUint16(34, true);
        return sampleFormat;
    }

    decode(chunk) {
        return chunk;
    }
}

// ─── TimeProvider ───────────────────────────────────────────────────────────
// now() returns ctx.currentTime * 1000 (ms since AudioContext creation)
// All time calculations happen in this domain — NOT Date.now()!

class TimeProvider {
    constructor(ctx) {
        this.ctx = null;
        this.diffBuffer = [];
        this.diff = 0;
        if (ctx) this.setAudioContext(ctx);
    }

    setAudioContext(ctx) {
        this.ctx = ctx;
        this.reset();
    }

    reset() {
        this.diffBuffer.length = 0;
        this.diff = 0;
    }

    setDiff(c2s, s2c) {
        if (this.now() === 0) {
            this.reset();
        } else {
            if (this.diffBuffer.push((c2s - s2c) / 2) > 100)
                this.diffBuffer.shift();
            const sorted = [...this.diffBuffer].sort((a, b) => a - b);
            this.diff = sorted[Math.floor(sorted.length / 2)];
        }
    }

    now() {
        if (!this.ctx) {
            return performance.now();
        }
        // Use getOutputTimestamp if available for better accuracy
        const ctx = this.ctx;
        if (ctx.getOutputTimestamp) {
            const ts = ctx.getOutputTimestamp();
            if (ts.contextTime !== undefined) {
                return ts.contextTime * 1000;
            }
        }
        return ctx.currentTime * 1000;
    }

    nowSec() {
        return this.now() / 1000;
    }

    serverNow() {
        return this.serverTime(this.now());
    }

    serverTime(localTimeMs) {
        return localTimeMs + this.diff;
    }
}

// ─── AudioStream ────────────────────────────────────────────────────────────
// Exact port of snapweb's AudioStream

class AudioStream {
    constructor(timeProvider, sampleFormat, bufferMs) {
        this._timeProvider = timeProvider;
        this._sampleFormat = sampleFormat;
        this._bufferMs = bufferMs;
        this.chunks = [];
        this.chunk = undefined;
        this.volume = 1;
        this.muted = false;
        this.lastLog = 0;
    }

    setVolume(percent, muted) {
        this.volume = percent / 100;
        this.muted = muted;
    }

    addChunk(chunk) {
        this.chunks.push(chunk);
        while (this.chunks.length > 0) {
            const age = this._timeProvider.serverNow() - this.chunks[0].timestamp.getMilliseconds();
            if (age > 5000 + this._bufferMs) {
                this.chunks.shift();
                console.log('Dropping old chunk: ' + age.toFixed(2) + ', left: ' + this.chunks.length);
            } else {
                break;
            }
        }
    }

    getNextBuffer(buffer, playTimeMs) {
        if (!this.chunk) {
            this.chunk = this.chunks.shift();
        }

        const frames = buffer.length;
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        let read = 0;
        let pos = 0;

        const serverPlayTimeMs = this._timeProvider.serverTime(playTimeMs);
        if (this.chunk) {
            let age = serverPlayTimeMs - this.chunk.startMs();
            const reqChunkDuration = frames / this._sampleFormat.msRate();

            const secs = Math.floor(Date.now() / 1000);
            if (this.lastLog !== secs) {
                this.lastLog = secs;
                console.log('age: ' + age.toFixed(2) + ', req: ' + reqChunkDuration);
            }

            if (age < -reqChunkDuration) {
                console.log('Chunk too young, returning silence');
            } else {
                if (Math.abs(age) > 5) {
                    // Hard sync: seek to desired position
                    while (this.chunk && age > this.chunk.duration()) {
                        console.log('Chunk too old, dropping (age: ' + age.toFixed(2) + ' > ' + this.chunk.duration().toFixed(2) + ')');
                        this.chunk = this.chunks.shift();
                        if (!this.chunk) break;
                        age = serverPlayTimeMs - this.chunk.startMs();
                    }
                    if (this.chunk) {
                        if (age > 0) {
                            console.log('Fast forwarding ' + age.toFixed(2) + 'ms');
                            this.chunk.readFrames(Math.floor(age * this.chunk.sampleFormat.msRate()));
                        } else if (age < 0) {
                            console.log('Playing silence ' + (-age).toFixed(2) + 'ms');
                            const silentFrames = Math.floor(-age * this.chunk.sampleFormat.msRate());
                            left.fill(0, 0, silentFrames);
                            right.fill(0, 0, silentFrames);
                            read = silentFrames;
                            pos = silentFrames;
                        }
                        age = 0;
                    }
                }

                // Soft sync
                let addFrames = 0;
                let everyN = 0;
                if (age > 0.1) {
                    addFrames = Math.ceil(age);
                } else if (age < -0.1) {
                    addFrames = Math.floor(age);
                }

                const readFrames = frames + addFrames - read;
                if (addFrames !== 0)
                    everyN = Math.ceil((frames + addFrames - read) / (Math.abs(addFrames) + 1));

                while ((read < readFrames) && this.chunk) {
                    const pcmChunk = this.chunk;
                    const pcmBuffer = pcmChunk.readFrames(readFrames - read);
                    const normalize = 2 ** pcmChunk.sampleFormat.bits;
                    let payload;
                    if (pcmChunk.sampleFormat.bits >= 24)
                        payload = new Int32Array(pcmBuffer);
                    else
                        payload = new Int16Array(pcmBuffer);

                    for (let i = 0; i < payload.length; i += 2) {
                        read++;
                        left[pos] = payload[i] / normalize;
                        right[pos] = payload[i + 1] / normalize;
                        if ((everyN !== 0) && (read % everyN === 0)) {
                            if (addFrames > 0) {
                                pos--;
                            } else {
                                left[pos + 1] = left[pos];
                                right[pos + 1] = right[pos];
                                pos++;
                            }
                        }
                        pos++;
                    }
                    if (pcmChunk.isEndOfChunk()) {
                        this.chunk = this.chunks.shift();
                    }
                }
                if (addFrames !== 0)
                    console.debug('Pos: ' + pos + ', frames: ' + frames + ', add: ' + addFrames + ', everyN: ' + everyN);
                if (read === readFrames)
                    read = frames;
            }
        }

        if (read < frames) {
            console.log('Failed to get chunk, read: ' + read + '/' + frames + ', chunks left: ' + this.chunks.length);
            left.fill(0, pos);
            right.fill(0, pos);
        }

        buffer.getChannelData(0).set(left);
        buffer.getChannelData(1).set(right);
    }
}

// ─── PlayBuffer ─────────────────────────────────────────────────────────────

class PlayBuffer {
    constructor(buffer, playTime, source, destination) {
        this.buffer = buffer;
        this.playTime = playTime;
        this.source = source;
        this.source.buffer = this.buffer;
        this.source.connect(destination);
        this.onended = () => {};
        this.num = 0;
    }

    start() {
        this.source.onended = () => {
            this.onended(this);
        };
        this.source.start(this.playTime);
    }
}

// ─── SnapClient ─────────────────────────────────────────────────────────────
// Wrapper that exposes the same API as before for app.js compatibility,
// but internally uses the exact snapweb SnapStream logic.

function _uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
    });
}

function _getClientId() {
    let id = localStorage.getItem('snapclient_uniqueId');
    if (!id) {
        id = _uuidv4();
        localStorage.setItem('snapclient_uniqueId', id);
    }
    return id;
}

class SnapClient {
    constructor() {
        this._ws = null;
        this._ctx = null;
        this._gainNode = null;
        this._connected = false;
        this._playing = false;
        this._onStateChange = null;

        // SnapStream internals
        this._timeProvider = new TimeProvider();
        this._stream = null;
        this._decoder = null;
        this._sampleFormat = null;
        this._serverSettings = null;
        this._msgId = 0;
        this._syncHandle = null;

        // Playback state
        this._playTime = 0;
        this._audioBuffers = [];
        this._freeBuffers = [];
        this._bufferDurationMs = 80;
        this._bufferFrameCount = 3844;
        this._audioBufferCount = 3;
        this._bufferMs = 1000;
        this._bufferNum = 0;
        this._latency = 0;

        // Auto-reconnect
        this._autoReconnect = false;
        this._reconnectHost = null;
        this._reconnectPort = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 1000;
        this._volume = 100;
    }

    connect(host, port = 1780) {
        if (this._ws) this._closeWs();
        this._autoReconnect = true;
        this._reconnectHost = host;
        this._reconnectPort = port;
        this._reconnectDelay = 1000;
        this._clearReconnectTimer();
        this._doConnect(host, port);
    }

    disconnect() {
        this._autoReconnect = false;
        this._clearReconnectTimer();
        if (this._syncHandle) {
            clearInterval(this._syncHandle);
            this._syncHandle = null;
        }
        this._stopAudio();
        this._closeWs();
        if (this._ctx) {
            this._ctx.close().catch(() => {});
            this._ctx = null;
            this._gainNode = null;
        }
        this._connected = false;
        this._playing = false;
        this._stream = null;
        this._decoder = null;
        this._sampleFormat = null;
        this._notify();
    }

    setVolume(vol) {
        this._volume = Math.max(0, Math.min(100, vol));
        if (this._gainNode) {
            this._gainNode.gain.value = this._volume / 100;
        }
    }

    get connected() { return this._connected; }
    get playing() { return this._playing; }
    set onStateChange(fn) { this._onStateChange = fn; }

    // ─── Internal ───

    _notify() {
        if (this._onStateChange) this._onStateChange(this._connected);
    }

    _doConnect(host, port) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${host}:${port}/stream`;

        this._timeProvider = new TimeProvider();
        this._stream = null;
        this._playTime = 0;
        this._audioBuffers = [];
        this._freeBuffers = [];
        this._playing = false;
        this._bufferNum = 0;

        try {
            this._ws = new WebSocket(url);
            this._ws.binaryType = 'arraybuffer';

            this._ws.onopen = () => {
                console.log('[SnapClient] Connected to', url);
                this._connected = true;
                this._reconnectDelay = 1000;

                const hello = new HelloMessage();
                hello.mac = '00:00:00:00:00:00';
                hello.arch = 'web';
                hello.os = navigator.platform || 'unknown';
                hello.hostname = 'Snapweb client';
                hello.uniqueId = _getClientId();
                this._sendMessage(hello);

                this._syncTime();
                this._syncHandle = setInterval(() => this._syncTime(), 1000);
                this._notify();
            };

            this._ws.onmessage = (ev) => this._onMessage(ev);

            this._ws.onclose = () => {
                console.log('[SnapClient] Disconnected');
                if (this._syncHandle) {
                    clearInterval(this._syncHandle);
                    this._syncHandle = null;
                }
                this._connected = false;
                this._playing = false;
                this._notify();
                if (this._autoReconnect) this._scheduleReconnect();
            };

            this._ws.onerror = (err) => {
                console.error('[SnapClient] WebSocket error', err);
            };
        } catch (e) {
            console.error('[SnapClient] Failed to connect:', e);
            if (this._autoReconnect) this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        this._clearReconnectTimer();
        console.log(`[SnapClient] Reconnecting in ${this._reconnectDelay}ms...`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._autoReconnect) this._doConnect(this._reconnectHost, this._reconnectPort);
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
        if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
        }
    }

    _setupAudioContext() {
        if (this._ctx) return true;
        if (!window.AudioContext && !window.webkitAudioContext) return false;

        const ACtor = window.AudioContext || window.webkitAudioContext;
        const options = {
            latencyHint: 'interactive',
            sampleRate: this._sampleFormat ? this._sampleFormat.rate : undefined,
        };
        this._ctx = new ACtor(options);
        this._gainNode = this._ctx.createGain();
        this._gainNode.connect(this._ctx.destination);
        return true;
    }

    _stopAudio() {
        this._ctx && this._ctx.suspend && this._ctx.suspend().catch(() => {});
        while (this._audioBuffers.length > 0) {
            const buf = this._audioBuffers.pop();
            buf.onended = () => {};
            buf.source.stop();
        }
        this._freeBuffers.length = 0;
    }

    // ─── Message handling (exact snapweb logic) ───

    _onMessage(msg) {
        const view = new DataView(msg.data);
        const type = view.getUint16(0, true);

        if (type === 1) {
            // Codec
            const codec = new CodecMessage(msg.data);
            console.log('[SnapClient] Codec: ' + codec.codec);
            if (codec.codec === 'pcm') {
                this._decoder = new PcmDecoder();
            } else {
                console.error('[SnapClient] Unsupported codec: ' + codec.codec + ' — snapserver must use codec=pcm');
                return;
            }
            this._sampleFormat = this._decoder.setHeader(codec.payload);
            console.log('[SnapClient] SampleFormat: ' + this._sampleFormat.rate + ':' + this._sampleFormat.bits + ':' + this._sampleFormat.channels);

            if (this._sampleFormat.channels !== 2 || this._sampleFormat.bits < 16) {
                console.error('[SnapClient] Stream must be stereo with 16/24/32 bit depth');
                return;
            }

            if (this._bufferDurationMs !== 0) {
                this._bufferFrameCount = Math.floor(this._bufferDurationMs * this._sampleFormat.msRate());
            }

            // Setup audio context with correct sample rate
            if (this._ctx && this._sampleFormat.rate !== this._ctx.sampleRate) {
                console.log('[SnapClient] Switching AudioContext to ' + this._sampleFormat.rate + ' Hz');
                this._stopAudio();
                this._ctx.close().catch(() => {});
                this._ctx = null;
                this._gainNode = null;
            }

            if (!this._setupAudioContext()) {
                console.error('[SnapClient] Web Audio API not supported');
                return;
            }

            this._ctx.resume();
            this._timeProvider.setAudioContext(this._ctx);

            // Apply server volume/mute if we have settings
            if (this._serverSettings) {
                this._gainNode.gain.value = this._serverSettings.muted ? 0 : this._serverSettings.volumePercent / 100;
            } else {
                this._gainNode.gain.value = this._volume / 100;
            }

            this._latency = (this._ctx.baseLatency || 0) + (this._ctx.outputLatency || 0);
            console.log('[SnapClient] Latency: base=' + (this._ctx.baseLatency || 0) + ', output=' + (this._ctx.outputLatency || 0));

            this._stream = new AudioStream(this._timeProvider, this._sampleFormat, this._bufferMs);
            this._play();

        } else if (type === 2) {
            // Wire chunk
            if (!this._decoder || !this._sampleFormat) return;
            const pcmChunk = new PcmChunkMessage(msg.data, this._sampleFormat);
            const decoded = this._decoder.decode(pcmChunk);
            if (decoded && this._stream) {
                this._stream.addChunk(decoded);
            }

        } else if (type === 3) {
            // Server settings
            this._serverSettings = new ServerSettingsMessage(msg.data);
            if (this._gainNode) {
                // Use local volume override if set, otherwise server volume
                this._gainNode.gain.value = this._serverSettings.muted ? 0 : this._volume / 100;
            }
            this._bufferMs = this._serverSettings.bufferMs - this._serverSettings.latency;
            console.log('[SnapClient] ServerSettings: bufferMs=' + this._serverSettings.bufferMs +
                ', latency=' + this._serverSettings.latency +
                ', volume=' + this._serverSettings.volumePercent +
                ', muted=' + this._serverSettings.muted);

        } else if (type === 4) {
            // Time sync
            if (this._timeProvider) {
                const time = new TimeMessage(msg.data);
                this._timeProvider.setDiff(
                    time.latency.getMilliseconds(),
                    this._timeProvider.now() - time.sent.getMilliseconds()
                );
            }
        }
    }

    _sendMessage(msg) {
        msg.sent = new Tv();
        msg.sent.setMilliseconds(this._timeProvider.now());
        msg.id = ++this._msgId;
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(msg.serialize());
        }
    }

    _syncTime() {
        const t = new TimeMessage();
        t.latency.setMilliseconds(this._timeProvider.now());
        this._sendMessage(t);
    }

    // ─── Playback (exact snapweb play/playNext) ───

    _play() {
        if (!this._ctx || !this._stream) return;
        this._playTime = this._timeProvider.nowSec() + 0.1;
        for (let i = 1; i <= this._audioBufferCount; ++i) {
            this._playNext();
        }
    }

    _playNext() {
        if (!this._ctx || !this._stream || !this._connected) return;

        const buffer = this._freeBuffers.pop() ||
            this._ctx.createBuffer(this._sampleFormat.channels, this._bufferFrameCount, this._sampleFormat.rate);
        const playTimeMs = (this._playTime + this._latency) * 1000 - this._bufferMs;
        this._stream.getNextBuffer(buffer, playTimeMs);

        const source = this._ctx.createBufferSource();
        const playBuffer = new PlayBuffer(buffer, this._playTime, source, this._gainNode);
        this._audioBuffers.push(playBuffer);
        playBuffer.num = ++this._bufferNum;
        playBuffer.onended = (buf) => {
            const idx = this._audioBuffers.indexOf(buf);
            if (idx !== -1) {
                this._freeBuffers.push(this._audioBuffers.splice(idx, 1)[0].buffer);
            }
            this._playNext();
        };
        playBuffer.start();
        this._playTime += this._bufferFrameCount / this._sampleFormat.rate;

        if (!this._playing) {
            this._playing = true;
            this._notify();
        }
    }
}
