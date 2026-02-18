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
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL,
    completed_at REAL
)
'''


async def get_db(path: str | None = None) -> aiosqlite.Connection:
    db = await aiosqlite.connect(path or DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute('PRAGMA journal_mode=WAL')
    return db


async def init_db(db: aiosqlite.Connection) -> None:
    await db.execute(SCHEMA)
    await db.commit()


async def insert_download(db: aiosqlite.Connection, job_id: str, url: str,
                          format_preset: str) -> None:
    now = time.time()
    await db.execute(
        'INSERT INTO downloads (id, url, format_preset, status, created_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (job_id, url, format_preset, 'queued', now, now),
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
        return dict(row) if row else None


async def list_downloads(db: aiosqlite.Connection, limit: int = 50,
                         offset: int = 0) -> list[dict]:
    async with db.execute(
        'SELECT * FROM downloads ORDER BY created_at DESC LIMIT ? OFFSET ?',
        (limit, offset),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def delete_download(db: aiosqlite.Connection, job_id: str) -> None:
    await db.execute('DELETE FROM downloads WHERE id = ?', (job_id,))
    await db.commit()


async def get_downloads_older_than(db: aiosqlite.Connection,
                                   cutoff_ts: float) -> list[dict]:
    async with db.execute(
        'SELECT * FROM downloads WHERE completed_at IS NOT NULL AND completed_at < ?',
        (cutoff_ts,),
    ) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
