-- A report becomes one reader's verdict on one account (#90). Each install keeps one row
-- per account: its newest label on any of that account's posts.

CREATE TABLE verdicts (
  reporter TEXT NOT NULL,
  handle TEXT NOT NULL,
  -- The post behind the verdict, and its thread.
  status TEXT NOT NULL,
  thread TEXT,
  label TEXT NOT NULL CHECK (label IN ('slop','not_slop')),
  net TEXT NOT NULL,
  -- When the verdict last changed side, rounded down to the hour. The 24-hour wait runs on it.
  at INTEGER NOT NULL,
  -- When the reader labelled that post: the start of the UTC day the extension sent, never
  -- later than the arrival hour, or the arrival hour when no day was sent. The 90-day window runs on it.
  labeled INTEGER NOT NULL,
  PRIMARY KEY (reporter, handle)
);
-- Carry over any existing reports: per install and account, the newest one, a tie going to Not slop.
-- The text hash is not carried; it was never used.
INSERT INTO verdicts (reporter, handle, status, thread, label, net, at, labeled)
  SELECT reporter, handle, status, thread, label, net, at, at FROM (
    SELECT reporter, handle, status, thread, label, net, at,
      ROW_NUMBER() OVER (PARTITION BY reporter, handle ORDER BY at DESC, label = 'not_slop' DESC, status DESC) AS rn
    FROM reports
  ) WHERE rn = 1;
DROP TABLE reports;
ALTER TABLE verdicts RENAME TO reports;
CREATE INDEX reports_handle ON reports(handle);
CREATE INDEX reports_labeled ON reports(labeled);

-- One standing request per account, holding only when it was made. Reasons and contacts are
-- no longer kept; open requests carry over at their time.
CREATE TABLE requests (handle TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
INSERT INTO requests (handle, at) SELECT handle, MAX(at) FROM removals WHERE status = 'open' GROUP BY handle;
DROP TABLE removals;
ALTER TABLE requests RENAME TO removals;

-- Every listed account is now listed by readers; the admin "list" override is gone.
DELETE FROM overrides WHERE action = 'list';
