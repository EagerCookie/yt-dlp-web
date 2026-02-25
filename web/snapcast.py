"""SnapCast integration — manages snapserver and provides JSON-RPC proxy."""

import asyncio
import json
import logging
import os

log = logging.getLogger(__name__)

FIFO_PATH = '/tmp/snapfifo'


class SnapcastManager:
    """Manages the named pipe to snapserver and proxies its JSON-RPC API."""

    def __init__(self):
        self._fifo_fd: int | None = None
        self._enabled: bool = False
        self._rpc_id: int = 0

    async def start(self):
        """Open the named pipe for writing (non-blocking)."""
        if not os.path.exists(FIFO_PATH):
            log.warning('snapfifo not found at %s — SnapCast disabled', FIFO_PATH)
            return
        try:
            # Open FIFO with O_WRONLY | O_NONBLOCK.
            # If snapserver is not yet reading, open will raise ENXIO on Linux.
            # We retry with O_RDWR which won't block even without a reader.
            self._fifo_fd = os.open(FIFO_PATH, os.O_RDWR | os.O_NONBLOCK)
            self._enabled = True
            log.info('SnapCast FIFO opened: %s', FIFO_PATH)
        except OSError as e:
            log.warning('Cannot open snapfifo: %s — SnapCast disabled', e)

    async def stop(self):
        """Close the FIFO."""
        if self._fifo_fd is not None:
            try:
                os.close(self._fifo_fd)
            except OSError:
                pass
            self._fifo_fd = None
        self._enabled = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    def write_chunk(self, chunk: bytes):
        """Write an audio chunk to the FIFO for snapserver."""
        if not self._enabled or self._fifo_fd is None:
            return
        try:
            os.write(self._fifo_fd, chunk)
        except (BrokenPipeError, OSError):
            # snapserver not reading or pipe full — skip silently
            pass

    # --- JSON-RPC proxy to snapserver (port 1705) ---

    async def _rpc_call(self, method: str, params: dict | None = None) -> dict:
        """Send a JSON-RPC request to snapserver control port."""
        self._rpc_id += 1
        request = {
            'id': self._rpc_id,
            'jsonrpc': '2.0',
            'method': method,
        }
        if params:
            request['params'] = params

        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection('127.0.0.1', 1705), timeout=3.0)
        except (ConnectionRefusedError, asyncio.TimeoutError, OSError) as e:
            log.warning('Cannot connect to snapserver JSON-RPC: %s', e)
            return {}

        try:
            payload = json.dumps(request) + '\r\n'
            writer.write(payload.encode())
            await writer.drain()

            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if line:
                return json.loads(line)
            return {}
        except Exception as e:
            log.warning('SnapCast RPC error: %s', e)
            return {}
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    async def get_status(self) -> dict:
        """Get full snapserver status (groups, clients, streams)."""
        resp = await self._rpc_call('Server.GetStatus')
        result = resp.get('result', {}).get('server', {})
        return result

    async def get_clients(self) -> list[dict]:
        """Get list of connected clients with their info."""
        status = await self.get_status()
        clients = []
        for group in status.get('groups', []):
            stream_id = group.get('stream_id', '')
            for client in group.get('clients', []):
                config = client.get('config', {})
                host = client.get('host', {})
                clients.append({
                    'id': client.get('id', ''),
                    'name': config.get('name', '') or host.get('name', '') or host.get('ip', 'Unknown'),
                    'connected': client.get('connected', False),
                    'volume': config.get('volume', {}).get('percent', 100),
                    'muted': config.get('volume', {}).get('muted', False),
                    'stream_id': stream_id,
                    'host_ip': host.get('ip', ''),
                })
        return clients

    async def set_client_volume(self, client_id: str, volume: int) -> dict:
        """Set volume for a specific client (0-100)."""
        volume = max(0, min(100, volume))
        resp = await self._rpc_call('Client.SetVolume', {
            'id': client_id,
            'volume': {'percent': volume, 'muted': False},
        })
        return resp.get('result', {})

    async def set_client_mute(self, client_id: str, muted: bool) -> dict:
        """Mute/unmute a specific client."""
        # First get current volume to preserve it
        clients = await self.get_clients()
        current_vol = 100
        for c in clients:
            if c['id'] == client_id:
                current_vol = c['volume']
                break
        resp = await self._rpc_call('Client.SetVolume', {
            'id': client_id,
            'volume': {'percent': current_vol, 'muted': muted},
        })
        return resp.get('result', {})
