// server/index.js
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { db, now, genId } from "./db.js";
import { printQueue } from "./queue.js";
import "./worker.js"; // registers the simulated printer consumer

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-webhook-secret";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// -------------------------- helpers -----------------------------------

function attendeeToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    qrCode: row.qr_code,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function printJobToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    attendeeId: row.attendee_id,
    status: row.status,
    simulate: row.simulate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function getAttendeeById(id) {
  return db.prepare("SELECT * FROM attendees WHERE id = ?").get(id);
}
function getAttendeeByQr(qr) {
  return db.prepare("SELECT * FROM attendees WHERE qr_code = ?").get(qr);
}
function getActivePrintJob(attendeeId) {
  return db
    .prepare("SELECT * FROM print_jobs WHERE attendee_id = ? AND status IN ('QUEUED','PROCESSING')")
    .get(attendeeId);
}
function getPrintJob(id) {
  return db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(id);
}
function getLatestCheckIn(attendeeId) {
  return db
    .prepare("SELECT * FROM check_ins WHERE attendee_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(attendeeId);
}

function logLine(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

// -------------------------- POST /api/check-in/scan --------------------

app.post("/api/check-in/scan", (req, res) => {
  const { qrCode, simulate } = req.body || {};
  if (!qrCode || typeof qrCode !== "string") {
    return res.status(400).json({ success: false, message: "qrCode is required" });
  }

  const attendee = getAttendeeByQr(qrCode.trim());
  if (!attendee) {
    logLine("SCAN", `Unknown QR code "${qrCode}"`);
    return res.status(404).json({ success: false, message: "Unknown QR code / attendee not found" });
  }

  logLine("SCAN", `Attendee ${attendee.id} scanned (current status=${attendee.status})`);

  if (attendee.status === "CHECKED_IN") {
    return res.status(409).json({
      success: false,
      status: "CHECKED_IN",
      message: "Attendee already checked in.",
      attendee: attendeeToJson(attendee),
    });
  }

  if (attendee.status === "PENDING") {
    const activeJob = getActivePrintJob(attendee.id);
    return res.status(409).json({
      success: false,
      status: "PENDING",
      message: "Badge printing is already in progress.",
      attendee: attendeeToJson(attendee),
      printJob: printJobToJson(activeJob),
    });
  }

  // status is REGISTERED or FAILED -> allowed to start a new print attempt
  const jobId = genId("JOB");
  const checkInId = genId("CI");
  const validSimulate = ["success", "failure", "delayed", "duplicate_webhook", "out_of_order"].includes(simulate)
    ? simulate
    : "success";

  const tx = db.prepare("BEGIN IMMEDIATE");
  try {
    tx.run();

    // DB-level guard: the unique partial index one_active_print_job_per_attendee
    // will throw if a race condition already inserted an active job for this
    // attendee between our read above and this write.
    db.prepare(
      `INSERT INTO print_jobs (id, attendee_id, status, simulate) VALUES (?, ?, 'QUEUED', ?)`
    ).run(jobId, attendee.id, validSimulate);

    db.prepare(
      `INSERT INTO check_ins (id, attendee_id, print_job_id, status) VALUES (?, ?, ?, 'PENDING')`
    ).run(checkInId, attendee.id, jobId);

    db.prepare(
      `UPDATE attendees SET status = 'PENDING', updated_at = ? WHERE id = ? AND status IN ('REGISTERED','FAILED')`
    ).run(now(), attendee.id);

    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    if (String(err.message).includes("UNIQUE")) {
      logLine("CHECK-IN", `Race detected for ${attendee.id}, rejecting duplicate print job`);
      const activeJob = getActivePrintJob(attendee.id);
      return res.status(409).json({
        success: false,
        status: "PENDING",
        message: "Badge printing is already in progress.",
        attendee: attendeeToJson(getAttendeeById(attendee.id)),
        printJob: printJobToJson(activeJob),
      });
    }
    console.error(err);
    return res.status(500).json({ success: false, message: "Database error creating check-in" });
  }

  logLine("CHECK-IN", `Created check-in ${checkInId} / print job ${jobId} for ${attendee.id}`);

  printQueue.publish({ id: jobId, attendeeId: attendee.id, simulate: validSimulate });
  logLine("QUEUE", `Print job ${jobId} published`);

  return res.status(202).json({
    success: true,
    status: "PENDING",
    message: "Badge printing started",
    attendee: attendeeToJson(getAttendeeById(attendee.id)),
    printJob: printJobToJson(getPrintJob(jobId)),
  });
});

// -------------------------- POST /api/webhooks/badge-printer -----------

app.post("/api/webhooks/badge-printer", (req, res) => {
  const signature = req.header("X-Webhook-Signature");
  if (signature !== WEBHOOK_SECRET) {
    logLine("WEBHOOK", "Rejected: invalid signature");
    return res.status(401).json({ success: false, message: "Invalid webhook signature" });
  }

  const { printJobId, attendeeId, status, completedAt } = req.body || {};

  if (!printJobId || !attendeeId || !status || !["SUCCESS", "FAILED"].includes(status)) {
    logLine("WEBHOOK", `Malformed payload: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ success: false, message: "Malformed webhook payload" });
  }

  const dedupeKey = `${printJobId}:${status}:${completedAt || "n/a"}`;
  const eventId = genId("EVT");

  // Idempotency gate: insert-or-detect-duplicate at the DB level via UNIQUE(dedupe_key)
  let isDuplicateEvent = false;
  try {
    db.prepare(
      `INSERT INTO webhook_events (id, print_job_id, attendee_id, status, completed_at, raw_payload, dedupe_key, applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(eventId, printJobId, attendeeId, status, completedAt || null, JSON.stringify(req.body), dedupeKey);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      isDuplicateEvent = true;
    } else {
      console.error(err);
      return res.status(500).json({ success: false, message: "Database error recording webhook event" });
    }
  }

  if (isDuplicateEvent) {
    logLine("WEBHOOK", `Duplicate callback ignored for ${printJobId} (dedupeKey=${dedupeKey})`);
    return res.status(200).json({
      success: true,
      status: "DUPLICATE_IGNORED",
      message: "Webhook already processed; no changes made.",
    });
  }

  logLine("WEBHOOK", `${printJobId} confirmation received (status=${status})`);

  const job = getPrintJob(printJobId);
  if (!job) {
    logLine("WEBHOOK", `Unknown print job ${printJobId}`);
    return res.status(404).json({ success: false, message: "Unknown print job" });
  }
  if (job.attendee_id !== attendeeId) {
    logLine("WEBHOOK", `Attendee mismatch for ${printJobId}: expected ${job.attendee_id}, got ${attendeeId}`);
    return res.status(400).json({ success: false, message: "printJobId does not belong to given attendeeId" });
  }

  // Terminal-state guard: if the job already reached SUCCESS/FAILED, this is
  // a late/duplicate/out-of-order callback for an already-resolved job.
  // We record it (above) for audit purposes but do not mutate state again.
  if (job.status === "SUCCESS" || job.status === "FAILED") {
    logLine("WEBHOOK", `${printJobId} already terminal (${job.status}); late/out-of-order callback ignored`);
    return res.status(200).json({
      success: true,
      status: "ALREADY_TERMINAL",
      message: `Print job already resolved as ${job.status}; callback ignored.`,
    });
  }

  const newJobStatus = status === "SUCCESS" ? "SUCCESS" : "FAILED";
  const tx = db.prepare("BEGIN IMMEDIATE");
  try {
    tx.run();
    db.prepare(`UPDATE print_jobs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('QUEUED','PROCESSING')`)
      .run(newJobStatus, completedAt || now(), now(), printJobId);

    // Out-of-order safety: only transition the ATTENDEE if this job is still
    // the attendee's currently-pending check-in. If a newer job has since
    // superseded it, we update the job record but leave attendee state alone.
    const pendingCheckIn = db
      .prepare("SELECT * FROM check_ins WHERE attendee_id = ? AND print_job_id = ? AND status = 'PENDING'")
      .get(attendeeId, printJobId);

    let attendeeTransitioned = false;
    if (pendingCheckIn) {
      const newAttendeeStatus = status === "SUCCESS" ? "CHECKED_IN" : "FAILED";
      db.prepare(`UPDATE check_ins SET status = ?, updated_at = ? WHERE id = ?`).run(
        newAttendeeStatus,
        now(),
        pendingCheckIn.id
      );
      db.prepare(`UPDATE attendees SET status = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`).run(
        newAttendeeStatus,
        now(),
        attendeeId
      );
      attendeeTransitioned = true;
    }

    db.prepare(`UPDATE webhook_events SET applied = 1 WHERE id = ?`).run(eventId);
    db.prepare("COMMIT").run();

    if (attendeeTransitioned) {
      logLine("CHECK-IN", `${attendeeId} marked ${status === "SUCCESS" ? "CHECKED_IN" : "FAILED"}`);
    }
  } catch (err) {
    db.prepare("ROLLBACK").run();
    console.error(err);
    return res.status(500).json({ success: false, message: "Database error applying webhook" });
  }

  return res.status(200).json({
    success: true,
    status: newJobStatus,
    message: `Print job ${printJobId} marked ${newJobStatus}`,
    attendee: attendeeToJson(getAttendeeById(attendeeId)),
    printJob: printJobToJson(getPrintJob(printJobId)),
  });
});

// -------------------------- GET endpoints -------------------------------

app.get("/api/attendees", (req, res) => {
  const rows = db.prepare("SELECT * FROM attendees ORDER BY created_at ASC").all();
  res.json({ success: true, attendees: rows.map(attendeeToJson) });
});

app.get("/api/attendees/:id", (req, res) => {
  const attendee = getAttendeeById(req.params.id);
  if (!attendee) return res.status(404).json({ success: false, message: "Attendee not found" });
  const checkIn = getLatestCheckIn(attendee.id);
  const printJob = checkIn?.print_job_id ? getPrintJob(checkIn.print_job_id) : null;
  res.json({
    success: true,
    attendee: attendeeToJson(attendee),
    latestCheckIn: checkIn
      ? { id: checkIn.id, status: checkIn.status, printJobId: checkIn.print_job_id, createdAt: checkIn.created_at, updatedAt: checkIn.updated_at }
      : null,
    printJob: printJobToJson(printJob),
  });
});

app.get("/api/check-ins/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM check_ins WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: "Check-in not found" });
  res.json({
    success: true,
    checkIn: {
      id: row.id,
      attendeeId: row.attendee_id,
      printJobId: row.print_job_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
});

app.get("/api/print-jobs", (req, res) => {
  const rows = db.prepare("SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 100").all();
  res.json({ success: true, printJobs: rows.map(printJobToJson) });
});

app.get("/api/dashboard", (req, res) => {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'CHECKED_IN' THEN 1 ELSE 0 END) AS checkedIn,
         SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'REGISTERED' THEN 1 ELSE 0 END) AS registered
       FROM attendees`
    )
    .get();

  const attendeeRows = db
    .prepare(
      `SELECT a.*,
              (SELECT pj.id FROM print_jobs pj WHERE pj.attendee_id = a.id ORDER BY pj.created_at DESC LIMIT 1) AS last_job_id,
              (SELECT pj.status FROM print_jobs pj WHERE pj.attendee_id = a.id ORDER BY pj.created_at DESC LIMIT 1) AS last_job_status
       FROM attendees a ORDER BY a.created_at ASC`
    )
    .all();

  const queuedOrProcessing = db
    .prepare("SELECT COUNT(*) AS c FROM print_jobs WHERE status IN ('QUEUED','PROCESSING')")
    .get().c;

  const recentJobs = db.prepare("SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 10").all();
  const recentEvents = db.prepare("SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 10").all();

  res.json({
    success: true,
    totals: {
      total: totals.total,
      checkedIn: totals.checkedIn || 0,
      pending: totals.pending || 0,
      failed: totals.failed || 0,
      registered: totals.registered || 0,
    },
    queue: {
      pendingJobsInDb: queuedOrProcessing,
      inMemoryQueueDepth: printQueue.jobs.length,
    },
    attendees: attendeeRows.map((r) => ({
      ...attendeeToJson(r),
      lastPrintJobId: r.last_job_id,
      lastPrintJobStatus: r.last_job_status,
    })),
    recentPrintJobs: recentJobs.map(printJobToJson),
    recentWebhookEvents: recentEvents.map((e) => ({
      id: e.id,
      printJobId: e.print_job_id,
      attendeeId: e.attendee_id,
      status: e.status,
      applied: !!e.applied,
      receivedAt: e.received_at,
    })),
  });
});

// -------------------------- demo/reset helper (not production) --------

app.post("/api/demo/reset", (req, res) => {
  db.exec("DELETE FROM webhook_events; DELETE FROM check_ins; DELETE FROM print_jobs;");
  db.prepare("UPDATE attendees SET status = 'REGISTERED', updated_at = ?").run(now());
  logLine("DEMO", "State reset to initial seed condition");
  res.json({ success: true, message: "Demo state reset" });
});

// -------------------------- error fallback ------------------------------

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Solstice check-in server listening on http://localhost:${PORT}`);
});
