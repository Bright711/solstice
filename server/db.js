// server/db.js
// -----------------------------------------------------------------------------
// Database layer. Uses Node's built-in synchronous SQLite driver (node:sqlite).
//
// WHY SQLITE INSTEAD OF POSTGRES FOR THIS MVP:
// The spec recommends PostgreSQL. For a locally-runnable MVP with zero external
// services, we use SQLite (via Node's native `node:sqlite` module, no native
// compilation required). The schema, constraints, and query patterns below are
// standard ANSI SQL and map 1:1 onto PostgreSQL (see README "Known limitations"
// for the migration note: swap this file for a `pg`/Prisma client and the rest
// of the app is unchanged, since all DB access goes through this module).
// -----------------------------------------------------------------------------

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "solstice.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS attendees (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  qr_code       TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'REGISTERED'
                  CHECK (status IN ('REGISTERED','PENDING','CHECKED_IN','FAILED')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per state transition (audit trail / "check-in" record per attempt)
CREATE TABLE IF NOT EXISTS check_ins (
  id            TEXT PRIMARY KEY,
  attendee_id   TEXT NOT NULL REFERENCES attendees(id),
  print_job_id  TEXT,
  status        TEXT NOT NULL
                  CHECK (status IN ('PENDING','CHECKED_IN','FAILED')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id            TEXT PRIMARY KEY,          -- e.g. JOB-001, globally unique
  attendee_id   TEXT NOT NULL REFERENCES attendees(id),
  status        TEXT NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED','PROCESSING','SUCCESS','FAILED')),
  simulate      TEXT NOT NULL DEFAULT 'success'
                  CHECK (simulate IN ('success','failure','delayed','duplicate_webhook','out_of_order')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  TEXT,
  -- Only ONE non-terminal (QUEUED/PROCESSING) job may exist per attendee at a time.
  -- Enforced below via a partial unique index.
  UNIQUE (attendee_id, status)
);

-- Idempotency ledger for webhook callbacks. Each (printJobId + status + a
-- content hash) is recorded exactly once; repeats are detected and ignored
-- before any state mutation happens.
CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT PRIMARY KEY,
  print_job_id    TEXT NOT NULL,
  attendee_id     TEXT NOT NULL,
  status          TEXT NOT NULL,
  completed_at    TEXT,
  raw_payload     TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,   -- printJobId:status:completedAt
  received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  applied         INTEGER NOT NULL DEFAULT 0 -- 1 if this event actually changed attendee state
);
`);

// SQLite can't do a plain "UNIQUE(attendee_id) WHERE status IN (...)" as a
// table constraint, so we use a partial unique INDEX instead: this is what
// actually blocks a second QUEUED/PROCESSING job per attendee at the DB level.
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS one_active_print_job_per_attendee
ON print_jobs(attendee_id)
WHERE status IN ('QUEUED','PROCESSING');
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_print_jobs_attendee ON print_jobs(attendee_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_checkins_attendee ON check_ins(attendee_id);`);

export function now() {
  return new Date().toISOString();
}

let counter = 0;
export function genId(prefix) {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}${counter}${rand}`.toUpperCase();
}
