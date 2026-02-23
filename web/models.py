import os
import time

import aiosqlite

DB_PATH = os.environ.get('DB_PATH', '/data/downloads.db')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS downloads (
    id           TEXT PRIMARY KEY,
    url          TEXT NOT NULL,
    title        TEXT,
    thumbnail    TEXT,
    duration     INTEGER,
    format_preset TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    error_msg    TEXT,
    file_path    TEXT,
    file_name    TEXT,
    file_size    INTEGER,
    pinned       INTEGER NOT NULL DEFAULT 0,
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL,
    completed_at REAL
)
'''

# Allowed sort columns to prevent SQL injection
_SORT_COLUMNS = {'created_at', 'title', 'file_size', 'duration'}


async def get_db(path: str | None = None) -> aiosqlite.Connection:
    db = await aiosqlite.connect(path or DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute('PRAGMA journal_mode=WAL')
    await db.execute('PRAGMA foreign_keys=ON')
    return db


async def _run_migrations(db: aiosqlite.Connection) -> None:
    """Additive schema migrations — safe to re-run."""
    # Add pinned column (for existing DBs that lack it)
    try:
        await db.execute(
            'ALTER TABLE downloads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    except Exception:
        pass  # column already exists

    # Tags table
    await db.execute('''
        CREATE TABLE IF NOT EXISTS tags (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            color      TEXT NOT NULL DEFAULT '#3b82f6',
            system     INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        )
    ''')

    # Add system column if missing (for existing DBs)
    try:
        await db.execute('ALTER TABLE tags ADD COLUMN system INTEGER NOT NULL DEFAULT 0')
    except Exception:
        pass

    # Junction table: downloads <-> tags
    await db.execute('''
        CREATE TABLE IF NOT EXISTS download_tags (
            download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
            tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (download_id, tag_id)
        )
    ''')

    # Playlists table
    await db.execute('''
        CREATE TABLE IF NOT EXISTS playlists (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'manual',
            smart_tag_ids TEXT,
            smart_sort  TEXT NOT NULL DEFAULT 'created_at',
            smart_order TEXT NOT NULL DEFAULT 'desc',
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL
        )
    ''')

    # Playlist items (manual playlists)
    await db.execute('''
        CREATE TABLE IF NOT EXISTS playlist_items (
            playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
            position    INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (playlist_id, download_id)
        )
    ''')

    await db.commit()


async def _ensure_system_tags(db: aiosqlite.Connection) -> None:
    """Create system tags (Audio, Video) if they don't exist."""
    system_tags = [
        ('Audio', '#22c55e'),
        ('Video', '#3b82f6'),
    ]
    for name, color in system_tags:
        try:
            await db.execute(
                'INSERT INTO tags (name, color, system, created_at) VALUES (?, ?, 1, ?)',
                (name, color, time.time()))
        except Exception:
            # Tag already exists — ensure it's marked as system
            await db.execute('UPDATE tags SET system = 1 WHERE name = ?', (name,))
    await db.commit()


async def init_db(db: aiosqlite.Connection) -> None:
    await db.execute(SCHEMA)
    await db.commit()
    await _run_migrations(db)
    await _ensure_system_tags(db)


# --- Downloads ---

async def insert_download(db: aiosqlite.Connection, job_id: str, url: str,
                          format_preset: str, pinned: bool = False) -> None:
    now = time.time()
    await db.execute(
        'INSERT INTO downloads (id, url, format_preset, status, pinned, created_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        (job_id, url, format_preset, 'queued', 1 if pinned else 0, now, now),
    )
    await db.commit()


async def update_download(db: aiosqlite.Connection, job_id: str, **fields) -> None:
    fields['updated_at'] = time.time()
    cols = ', '.join(f'{k} = ?' for k in fields)
    vals = list(fields.values())
    vals.append(job_id)
    await db.execute(f'UPDATE downloads SET {cols} WHERE id = ?', vals)
    await db.commit()


async def get_download(db: aiosqlite.Connection, job_id: str) -> dict | None:
    async with db.execute('SELECT * FROM downloads WHERE id = ?', (job_id,)) as cur:
        row = await cur.fetchone()
        if not row:
            return None
        result = dict(row)
    result['tags'] = await get_tags_for_download(db, job_id)
    return result


async def list_downloads(db: aiosqlite.Connection, limit: int = 50,
                         offset: int = 0, tag_id: int | None = None,
                         tag_ids: list[int] | None = None,
                         search: str | None = None,
                         sort_by: str = 'created_at',
                         sort_order: str = 'desc',
                         pinned_only: bool = False,
                         format_preset: str | None = None,
                         status: str | None = None) -> list[dict]:
    # Validate sort params
    if sort_by not in _SORT_COLUMNS:
        sort_by = 'created_at'
    if sort_order not in ('asc', 'desc'):
        sort_order = 'desc'

    conditions = []
    params: list = []

    # Multiple tag IDs (OR logic — match any of the selected tags)
    if tag_ids:
        placeholders = ','.join('?' * len(tag_ids))
        conditions.append(
            f'd.id IN (SELECT download_id FROM download_tags WHERE tag_id IN ({placeholders}))')
        params.extend(tag_ids)
    elif tag_id is not None:
        conditions.append('d.id IN (SELECT download_id FROM download_tags WHERE tag_id = ?)')
        params.append(tag_id)

    if search:
        conditions.append('(d.title LIKE ? OR d.url LIKE ?)')
        params.extend([f'%{search}%', f'%{search}%'])

    if pinned_only:
        conditions.append('d.pinned = 1')

    if format_preset:
        if format_preset == 'video':
            conditions.append("d.format_preset != 'audio_mp3'")
        else:
            conditions.append('d.format_preset = ?')
            params.append(format_preset)

    if status:
        conditions.append('d.status = ?')
        params.append(status)

    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
    order = f'ORDER BY d.{sort_by} {sort_order}'
    query = f'SELECT d.* FROM downloads d {where} {order} LIMIT ? OFFSET ?'
    params.extend([limit, offset])

    async with db.execute(query, params) as cur:
        rows = [dict(r) for r in await cur.fetchall()]

    if rows:
        await _attach_tags(db, rows)

    return rows


async def delete_download(db: aiosqlite.Connection, job_id: str) -> None:
    await db.execute('DELETE FROM downloads WHERE id = ?', (job_id,))
    await db.commit()


async def get_downloads_older_than(db: aiosqlite.Connection,
                                   cutoff_ts: float) -> list[dict]:
    async with db.execute(
        'SELECT * FROM downloads '
        'WHERE completed_at IS NOT NULL AND completed_at < ? AND pinned = 0',
        (cutoff_ts,),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


# --- Bulk operations ---

async def bulk_pin(db: aiosqlite.Connection, job_ids: list[str], pinned: bool) -> None:
    val = 1 if pinned else 0
    now = time.time()
    for jid in job_ids:
        await db.execute('UPDATE downloads SET pinned = ?, updated_at = ? WHERE id = ?',
                         (val, now, jid))
    await db.commit()


async def bulk_add_tag(db: aiosqlite.Connection, job_ids: list[str], tag_id: int) -> None:
    for jid in job_ids:
        await db.execute(
            'INSERT OR IGNORE INTO download_tags (download_id, tag_id) VALUES (?, ?)',
            (jid, tag_id))
    await db.commit()


async def bulk_delete(db: aiosqlite.Connection, job_ids: list[str]) -> list[dict]:
    """Delete downloads and return their file_path info for cleanup."""
    deleted = []
    for jid in job_ids:
        async with db.execute('SELECT file_path FROM downloads WHERE id = ?', (jid,)) as cur:
            row = await cur.fetchone()
            if row:
                deleted.append(dict(row))
        await db.execute('DELETE FROM downloads WHERE id = ?', (jid,))
    await db.commit()
    return deleted


# --- Pin ---

async def toggle_pin(db: aiosqlite.Connection, job_id: str) -> bool:
    """Toggle pinned state. Returns new pinned value."""
    async with db.execute('SELECT pinned FROM downloads WHERE id = ?',
                          (job_id,)) as cur:
        row = await cur.fetchone()
        if not row:
            return False
    new_val = 0 if row['pinned'] else 1
    await db.execute('UPDATE downloads SET pinned = ?, updated_at = ? WHERE id = ?',
                     (new_val, time.time(), job_id))
    await db.commit()
    return bool(new_val)


# --- Tags ---

async def create_tag(db: aiosqlite.Connection, name: str, color: str,
                     system: bool = False) -> dict:
    now = time.time()
    cursor = await db.execute(
        'INSERT INTO tags (name, color, system, created_at) VALUES (?, ?, ?, ?)',
        (name, color, 1 if system else 0, now))
    await db.commit()
    return {'id': cursor.lastrowid, 'name': name, 'color': color,
            'system': 1 if system else 0, 'created_at': now}


async def list_tags(db: aiosqlite.Connection) -> list[dict]:
    """List all tags with download count."""
    async with db.execute(
        'SELECT t.*, COUNT(dt.download_id) as count '
        'FROM tags t LEFT JOIN download_tags dt ON t.id = dt.tag_id '
        'GROUP BY t.id ORDER BY t.system DESC, t.name'
    ) as cur:
        return [dict(r) for r in await cur.fetchall()]


async def get_tag_by_name(db: aiosqlite.Connection, name: str) -> dict | None:
    async with db.execute('SELECT * FROM tags WHERE name = ?', (name,)) as cur:
        row = await cur.fetchone()
        return dict(row) if row else None


async def update_tag(db: aiosqlite.Connection, tag_id: int, **fields) -> None:
    if not fields:
        return
    cols = ', '.join(f'{k} = ?' for k in fields)
    vals = list(fields.values())
    vals.append(tag_id)
    await db.execute(f'UPDATE tags SET {cols} WHERE id = ?', vals)
    await db.commit()


async def delete_tag(db: aiosqlite.Connection, tag_id: int) -> None:
    await db.execute('DELETE FROM tags WHERE id = ?', (tag_id,))
    await db.commit()


async def get_tags_for_download(db: aiosqlite.Connection,
                                download_id: str) -> list[dict]:
    async with db.execute(
        'SELECT t.id, t.name, t.color FROM tags t '
        'JOIN download_tags dt ON t.id = dt.tag_id '
        'WHERE dt.download_id = ? ORDER BY t.name', (download_id,),
    ) as cur:
        return [dict(r) for r in await cur.fetchall()]


async def add_tag_to_download(db: aiosqlite.Connection,
                              download_id: str, tag_id: int) -> None:
    await db.execute(
        'INSERT OR IGNORE INTO download_tags (download_id, tag_id) VALUES (?, ?)',
        (download_id, tag_id))
    await db.commit()


async def remove_tag_from_download(db: aiosqlite.Connection,
                                   download_id: str, tag_id: int) -> None:
    await db.execute(
        'DELETE FROM download_tags WHERE download_id = ? AND tag_id = ?',
        (download_id, tag_id))
    await db.commit()


# --- Playlists ---

async def create_playlist(db: aiosqlite.Connection, name: str,
                           pl_type: str = 'manual',
                           smart_tag_ids: str | None = None,
                           smart_sort: str = 'created_at',
                           smart_order: str = 'desc') -> dict:
    now = time.time()
    cursor = await db.execute(
        'INSERT INTO playlists (name, type, smart_tag_ids, smart_sort, smart_order, '
        'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (name, pl_type, smart_tag_ids, smart_sort, smart_order, now, now))
    await db.commit()
    return {'id': cursor.lastrowid, 'name': name, 'type': pl_type,
            'smart_tag_ids': smart_tag_ids, 'smart_sort': smart_sort,
            'smart_order': smart_order, 'created_at': now, 'updated_at': now}


async def list_playlists(db: aiosqlite.Connection) -> list[dict]:
    """List all playlists with item counts."""
    async with db.execute(
        'SELECT p.*, COUNT(pi.download_id) as item_count '
        'FROM playlists p LEFT JOIN playlist_items pi ON p.id = pi.playlist_id '
        'GROUP BY p.id ORDER BY p.updated_at DESC'
    ) as cur:
        rows = [dict(r) for r in await cur.fetchall()]

    # For smart playlists, compute actual item count from matching downloads
    for row in rows:
        if row['type'] == 'smart' and row.get('smart_tag_ids'):
            tag_ids = [int(x) for x in row['smart_tag_ids'].split(',') if x.strip()]
            if tag_ids:
                placeholders = ','.join('?' * len(tag_ids))
                async with db.execute(
                    f'SELECT COUNT(DISTINCT d.id) as cnt FROM downloads d '
                    f'JOIN download_tags dt ON d.id = dt.download_id '
                    f'WHERE dt.tag_id IN ({placeholders}) AND d.status = ?',
                    [*tag_ids, 'done'],
                ) as cur:
                    cnt_row = await cur.fetchone()
                    row['item_count'] = cnt_row['cnt'] if cnt_row else 0
    return rows


async def get_playlist(db: aiosqlite.Connection,
                        playlist_id: int) -> dict | None:
    async with db.execute('SELECT * FROM playlists WHERE id = ?',
                           (playlist_id,)) as cur:
        row = await cur.fetchone()
        return dict(row) if row else None


async def update_playlist(db: aiosqlite.Connection,
                           playlist_id: int, **fields) -> None:
    fields['updated_at'] = time.time()
    cols = ', '.join(f'{k} = ?' for k in fields)
    vals = list(fields.values())
    vals.append(playlist_id)
    await db.execute(f'UPDATE playlists SET {cols} WHERE id = ?', vals)
    await db.commit()


async def delete_playlist(db: aiosqlite.Connection,
                           playlist_id: int) -> None:
    await db.execute('DELETE FROM playlists WHERE id = ?', (playlist_id,))
    await db.commit()


async def add_playlist_item(db: aiosqlite.Connection, playlist_id: int,
                             download_id: str) -> None:
    # Get next position
    async with db.execute(
        'SELECT COALESCE(MAX(position), -1) + 1 as next_pos '
        'FROM playlist_items WHERE playlist_id = ?', (playlist_id,),
    ) as cur:
        row = await cur.fetchone()
        pos = row['next_pos']
    await db.execute(
        'INSERT OR IGNORE INTO playlist_items (playlist_id, download_id, position) '
        'VALUES (?, ?, ?)', (playlist_id, download_id, pos))
    await db.execute('UPDATE playlists SET updated_at = ? WHERE id = ?',
                     (time.time(), playlist_id))
    await db.commit()


async def remove_playlist_item(db: aiosqlite.Connection, playlist_id: int,
                                download_id: str) -> None:
    await db.execute(
        'DELETE FROM playlist_items WHERE playlist_id = ? AND download_id = ?',
        (playlist_id, download_id))
    await db.execute('UPDATE playlists SET updated_at = ? WHERE id = ?',
                     (time.time(), playlist_id))
    await db.commit()


async def reorder_playlist_items(db: aiosqlite.Connection, playlist_id: int,
                                  ordered_ids: list[str]) -> None:
    """Set positions based on order of IDs in the list."""
    for i, dl_id in enumerate(ordered_ids):
        await db.execute(
            'UPDATE playlist_items SET position = ? '
            'WHERE playlist_id = ? AND download_id = ?',
            (i, playlist_id, dl_id))
    await db.execute('UPDATE playlists SET updated_at = ? WHERE id = ?',
                     (time.time(), playlist_id))
    await db.commit()


async def get_playlist_items(db: aiosqlite.Connection,
                              playlist_id: int) -> list[dict]:
    """Resolve playlist items. Manual: from playlist_items. Smart: from tag filter."""
    playlist = await get_playlist(db, playlist_id)
    if not playlist:
        return []

    if playlist['type'] == 'smart':
        return await _resolve_smart_playlist(db, playlist)
    else:
        return await _resolve_manual_playlist(db, playlist_id)


async def _resolve_manual_playlist(db: aiosqlite.Connection,
                                    playlist_id: int) -> list[dict]:
    async with db.execute(
        'SELECT d.* FROM downloads d '
        'JOIN playlist_items pi ON d.id = pi.download_id '
        'WHERE pi.playlist_id = ? ORDER BY pi.position',
        (playlist_id,),
    ) as cur:
        rows = [dict(r) for r in await cur.fetchall()]

    if rows:
        await _attach_tags(db, rows)
    return rows


async def _resolve_smart_playlist(db: aiosqlite.Connection,
                                   playlist: dict) -> list[dict]:
    tag_ids_str = playlist.get('smart_tag_ids', '')
    if not tag_ids_str:
        return []
    try:
        tag_ids = [int(x) for x in tag_ids_str.split(',') if x.strip()]
    except ValueError:
        return []
    if not tag_ids:
        return []

    sort_col = playlist.get('smart_sort', 'created_at')
    if sort_col not in _SORT_COLUMNS:
        sort_col = 'created_at'
    sort_ord = playlist.get('smart_order', 'desc')
    if sort_ord not in ('asc', 'desc'):
        sort_ord = 'desc'

    placeholders = ','.join('?' * len(tag_ids))
    query = (
        f'SELECT DISTINCT d.* FROM downloads d '
        f'JOIN download_tags dt ON d.id = dt.download_id '
        f'WHERE dt.tag_id IN ({placeholders}) AND d.status = ? '
        f'ORDER BY d.{sort_col} {sort_ord}'
    )
    async with db.execute(query, [*tag_ids, 'done']) as cur:
        rows = [dict(r) for r in await cur.fetchall()]

    if rows:
        await _attach_tags(db, rows)
    return rows


async def _attach_tags(db: aiosqlite.Connection, rows: list[dict]) -> None:
    """Batch-fetch and attach tags to download rows."""
    ids = [r['id'] for r in rows]
    placeholders = ','.join('?' * len(ids))
    async with db.execute(
        f'SELECT dt.download_id, t.id, t.name, t.color '
        f'FROM download_tags dt JOIN tags t ON t.id = dt.tag_id '
        f'WHERE dt.download_id IN ({placeholders})', ids,
    ) as cur:
        tag_rows = await cur.fetchall()

    tag_map: dict[str, list[dict]] = {}
    for tr in tag_rows:
        tr = dict(tr)
        did = tr.pop('download_id')
        tag_map.setdefault(did, []).append(tr)

    for row in rows:
        row['tags'] = tag_map.get(row['id'], [])
