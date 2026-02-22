CREATE TABLE IF NOT EXISTS admins (
    user_id    INTEGER PRIMARY KEY,
    username   TEXT,
    added_by   INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dinings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE NOT NULL,
    added_by   INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    submission_date TEXT    NOT NULL,
    count           INTEGER DEFAULT 1,
    deleted         INTEGER DEFAULT 0,
    UNIQUE(user_id, submission_date)
);

CREATE TABLE IF NOT EXISTS user_states (
    user_id    INTEGER PRIMARY KEY,
    state_data TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
    user_id    INTEGER PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_activity (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    period_type  TEXT    NOT NULL,
    period_value TEXT    NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, period_type, period_value)
);

CREATE TABLE IF NOT EXISTS stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_type    TEXT NOT NULL,
    period_type  TEXT NOT NULL,
    period_value TEXT NOT NULL,
    value        INTEGER DEFAULT 0,
    UNIQUE(stat_type, period_type, period_value)
);

CREATE TABLE IF NOT EXISTS popular_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,
    item_name TEXT NOT NULL,
    count     INTEGER DEFAULT 0,
    UNIQUE(item_type, item_name)
);

CREATE TABLE IF NOT EXISTS request_cache (
    request_key TEXT PRIMARY KEY,
    created_at  TEXT DEFAULT (datetime('now'))
);