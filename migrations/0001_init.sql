-- ADHD toolkit — digest + organizer tables.

-- digest_runs: one row per cron firing or manual /digest/run call.
CREATE TABLE IF NOT EXISTS digest_runs (
  id TEXT PRIMARY KEY,                          -- run_id (uuid v4)
  triggered_by TEXT NOT NULL,                   -- "cron" | "manual" | "<other>"
  started_at TEXT NOT NULL,                     -- ISO8601
  completed_at TEXT,                            -- ISO8601 on terminal
  status TEXT NOT NULL DEFAULT 'started',       -- started | done | failed
  sources_json TEXT NOT NULL,                   -- which sources were read this run
  digest_text TEXT,                             -- the rendered digest body
  delivery_targets_json TEXT,                   -- where the digest was delivered (file, discord, ntfy)
  delivery_results_json TEXT,                   -- per-target ok/err
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_digest_runs_started_at ON digest_runs(started_at DESC);

-- tool_proposals: organizer's output. Rule-of-three: surfaces when same shape detected 3+ times.
CREATE TABLE IF NOT EXISTS tool_proposals (
  id TEXT PRIMARY KEY,                          -- proposal_id
  detected_at TEXT NOT NULL,                    -- ISO8601 when organizer first flagged
  shape_signature TEXT NOT NULL,                -- semantic shape (e.g. "queue-poller", "context-injector")
  shape_summary TEXT NOT NULL,                  -- one-line plain English summary of the shape
  hit_count INTEGER NOT NULL DEFAULT 0,         -- how many times this shape has been observed
  hit_run_ids_json TEXT NOT NULL,               -- digest_runs.id list where this shape was seen
  example_snippets_json TEXT NOT NULL,          -- 3-5 representative snippets from digests
  status TEXT NOT NULL DEFAULT 'open',          -- open | acknowledged | formalized | dismissed
  formalized_as TEXT,                           -- if status=formalized, the tool that resulted
  acknowledged_at TEXT,
  formalized_at TEXT,
  dismissed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_proposals_status ON tool_proposals(status);
CREATE INDEX IF NOT EXISTS idx_tool_proposals_hit_count ON tool_proposals(hit_count DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_proposals_shape ON tool_proposals(shape_signature);
