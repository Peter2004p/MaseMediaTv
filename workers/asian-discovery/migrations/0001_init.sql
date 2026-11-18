PRAGMA foreign_keys = ON;

-- Preview-only bootstrap. On production, titles already exists; IF NOT EXISTS preserves it.
CREATE TABLE IF NOT EXISTS titles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  poster_url TEXT NOT NULL DEFAULT '',
  year INTEGER,
  kind TEXT NOT NULL DEFAULT 'movie' CHECK (kind IN ('movie','drama','reel')),
  season INTEGER,
  episode INTEGER,
  quality TEXT NOT NULL DEFAULT '',
  stream_url TEXT NOT NULL DEFAULT '',
  download_url TEXT NOT NULL DEFAULT '',
  subtitles_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asian_titles_name_year ON titles(name, year, kind);

CREATE TABLE IF NOT EXISTS asian_discovery_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  language TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  licence_name TEXT NOT NULL DEFAULT '',
  licence_url TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  poster_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review','eligible','published','duplicate','rejected','failed')),
  published_title_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_asian_discovery_status ON asian_discovery_items(status, discovered_at DESC);

CREATE TABLE IF NOT EXISTS asian_discovery_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  found_count INTEGER NOT NULL DEFAULT 0,
  published_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
