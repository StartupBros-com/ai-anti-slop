CREATE TABLE reporters (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
CREATE TABLE reports (
  reporter TEXT NOT NULL, status TEXT NOT NULL, handle TEXT NOT NULL,
  thread TEXT, hash TEXT, label TEXT NOT NULL CHECK (label IN ('slop','not_slop')),
  net TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (reporter, status)
);
CREATE INDEX reports_label_at ON reports(label, at);
CREATE INDEX reports_handle ON reports(handle);
CREATE TABLE counters (kind TEXT NOT NULL, subject TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (kind, subject, day));
CREATE TABLE overrides (handle TEXT PRIMARY KEY, action TEXT NOT NULL CHECK (action IN ('delist','list')), note TEXT, at INTEGER NOT NULL);
CREATE TABLE removals (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, reason TEXT, contact TEXT, net TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', note TEXT);
CREATE TABLE listed (handle TEXT PRIMARY KEY, reporters INTEGER NOT NULL, since INTEGER NOT NULL);
CREATE TABLE next_listed (handle TEXT PRIMARY KEY, reporters INTEGER NOT NULL, since INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE changes (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, count INTEGER NOT NULL, added TEXT NOT NULL, removed TEXT NOT NULL);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
