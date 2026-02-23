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
            created_at REAL NOT NULL
        )
    ''')

    # Junction table: downloads <-> tags
    await db.execute('''
        CREATE TABLE IF NOT EXISTS download_tags (
            download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
            tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (download_id, tag_id)
        )
    ''')

    await db.commit()


async def init_db(db: aiosqlite.Connection) -> None:
    await db.execute(SCHEMA)
    await db.commit()
    await _run_migrations(db)


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
    # Attach tags
    result['tags'] = await get_tags_for_download(db, job_id)
    return result


async def list_downloads(db: aiosqlite.Connection, limit: int = 50,
                         offset: int = 0, tag_id: int | None = None) -> list[dict]:
    if tag_id is not None:
        query = (
            'SELECT d.* FROM downloads d '
            'JOIN download_tags dt ON d.id = dt.download_id '
            'WHERE dt.tag_id = ? '
            'ORDER BY d.pinned DESC, d.created_at DESC LIMIT ? OFFSET ?'
        )
        params = (tag_id, limit, offset)
    else:
        query = ('SELECT * FROM downloads '
                 'ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?')
        params = (limit, offset)

    async with db.execute(query, params) as cur:
        rows = [dict(r) for r in await cur.fetchall()]

    # Batch-fetch tags for all returned downloads
    if rows:
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

async def create_tag(db: aiosqlite.Connection, name: str, color: str) -> dict:
    now = time.time()
    cursor = await db.execute(
        'INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)',
        (name, color, now))
    await db.commit()
    return {'id': cursor.lastrowid, 'name': name, 'color': color, 'created_at': now}


async def list_tags(db: aiosqlite.Connection) -> list[dict]:
    async with db.execute('SELECT * FROM tags ORDER BY name') as cur:
        return [dict(r) for r in await cur.fetchall()]


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
