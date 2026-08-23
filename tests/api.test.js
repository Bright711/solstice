// tests/api.test.js
// Runs against a live instance of the server on an isolated test DB/port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 4501;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = path.join(ROOT, "data", "test.db");
const WEBHOOK_SECRET = "test-secret";

let serverProcess;

function waitForServer(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = async () => {
      try {
        const res = await fetch(url);
        if (res.status) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("server did not start in time"));
      setTimeout(tryOnce, 150);
    };
    tryOnce();
  });
}

before(async () => {
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(TEST_DB + ext)) fs.rmSync(TEST_DB + ext);
  }

  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: TEST_DB,
    WEBHOOK_SECRET,
  };

  // seed first
  await new Promise((resolve, reject) => {
    const seed = spawn("node", ["server/seed.js"], { cwd: ROOT, env });
    seed.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("seed failed"))));
  });

  serverProcess = spawn("node", ["server/index.js"], { cwd: ROOT, env });
  serverProcess.stdout.on("data", () => {});
  serverProcess.stderr.on("data", () => {});

  await waitForServer(`${BASE}/api/attendees`);
});

after(() => {
  if (serverProcess) serverProcess.kill();
});

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scan(qrCode, simulate) {
  const res = await fetch(`${BASE}/api/check-in/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qrCode, simulate }),
  });
  return { status: res.status, body: await res.json() };
}

async function getAttendee(id) {
  const res = await fetch(`${BASE}/api/attendees/${id}`);
  return res.json();
}

async function sendWebhook(payload, signature = WEBHOOK_SECRET) {
  const res = await fetch(`${BASE}/api/webhooks/badge-printer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Signature": signature },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForStatus(id, status, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await getAttendee(id);
    if (data.attendee.status === status) return data;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${id} to reach ${status}`);
}

// -------------------------------------------------------------------------

test("1. successful check-in reaches CHECKED_IN via async webhook flow", async () => {
  const { status, body } = await scan("ATT-001", "success");
  assert.equal(status, 202);
  assert.equal(body.status, "PENDING");
  const final = await waitForStatus("ATT-001", "CHECKED_IN");
  assert.equal(final.attendee.status, "CHECKED_IN");
  assert.equal(final.printJob.status, "SUCCESS");
});

test("2. unknown attendee QR code returns 404", async () => {
  const { status, body } = await scan("NOT-A-REAL-CODE");
  assert.equal(status, 404);
  assert.equal(body.success, false);
});

test("3. duplicate scan while PENDING does not create a second job", async () => {
  const first = await scan("ATT-002", "delayed");
  assert.equal(first.status, 202);
  const jobId = first.body.printJob.id;

  const second = await scan("ATT-002", "delayed");
  assert.equal(second.status, 409);
  assert.equal(second.body.message, "Badge printing is already in progress.");
  assert.equal(second.body.printJob.id, jobId, "must reference the SAME job, not a new one");

  // clean up: let it resolve before next test touches ATT-002
  await waitForStatus("ATT-002", "CHECKED_IN", 8000);
});

test("4. duplicate scan after CHECKED_IN is rejected and prints nothing new", async () => {
  await waitForStatus("ATT-001", "CHECKED_IN");
  const { status, body } = await scan("ATT-001", "success");
  assert.equal(status, 409);
  assert.equal(body.message, "Attendee already checked in.");
});

test("5. successful webhook transitions PENDING -> CHECKED_IN", async () => {
  const { body } = await scan("ATT-003", "success");
  const jobId = body.printJob.id;
  await waitForStatus("ATT-003", "CHECKED_IN");
  const jobsRes = await fetch(`${BASE}/api/print-jobs`);
  const jobs = (await jobsRes.json()).printJobs;
  const job = jobs.find((j) => j.id === jobId);
  assert.equal(job.status, "SUCCESS");
});

test("6. duplicate webhook callback is idempotent and ignored", async () => {
  const jobsRes = await fetch(`${BASE}/api/print-jobs`);
  const jobs = (await jobsRes.json()).printJobs;
  const job = jobs.find((j) => j.attendeeId === "ATT-003");
  const payload = { printJobId: job.id, attendeeId: "ATT-003", status: "SUCCESS", completedAt: job.completedAt };

  const replay = await sendWebhook(payload);
  assert.equal(replay.status, 200);
  assert.ok(["DUPLICATE_IGNORED", "ALREADY_TERMINAL"].includes(replay.body.status));

  const after = await getAttendee("ATT-003");
  assert.equal(after.attendee.status, "CHECKED_IN", "state must remain correct after duplicate webhook");
});

test("7. printer failure marks attendee FAILED, not CHECKED_IN", async () => {
  // reset a fresh attendee slot by reusing seed data structure via new scan flow
  const res = await fetch(`${BASE}/api/demo/reset`, { method: "POST" });
  assert.equal(res.status, 200);

  const { body } = await scan("ATT-001", "failure");
  assert.equal(body.status, "PENDING");
  const final = await waitForStatus("ATT-001", "FAILED");
  assert.equal(final.attendee.status, "FAILED");
  assert.equal(final.printJob.status, "FAILED");
});

test("8. invalid webhook (bad signature) is rejected", async () => {
  const { status, body } = await sendWebhook(
    { printJobId: "JOB-FAKE", attendeeId: "ATT-001", status: "SUCCESS", completedAt: new Date().toISOString() },
    "wrong-secret"
  );
  assert.equal(status, 401);
  assert.equal(body.success, false);
});

test("8b. malformed webhook payload is rejected", async () => {
  const { status } = await sendWebhook({ printJobId: "JOB-X" }); // missing fields
  assert.equal(status, 400);
});

test("9. out-of-order webhook callbacks leave the correct final state", async () => {
  // ATT-001 is currently FAILED (from test 7) after reset — retry to get a new job
  const { body } = await scan("ATT-001", "success");
  const jobId = body.printJob.id;

  const completedFirst = new Date(Date.now() + 1000).toISOString(); // "later" event
  const completedSecond = new Date(Date.now()).toISOString(); // "earlier" event, arrives second

  // Simulate the LATER-timestamped SUCCESS callback arriving first...
  const r1 = await sendWebhook({ printJobId: jobId, attendeeId: "ATT-001", status: "SUCCESS", completedAt: completedFirst });
  assert.equal(r1.status, 200);

  await waitForStatus("ATT-001", "CHECKED_IN");

  // ...then a stale/earlier duplicate-looking callback for the SAME job arrives after.
  // Because the job is already terminal, this must be ignored and not corrupt state.
  const r2 = await sendWebhook({ printJobId: jobId, attendeeId: "ATT-001", status: "SUCCESS", completedAt: completedSecond });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.status, "ALREADY_TERMINAL");

  const finalState = await getAttendee("ATT-001");
  assert.equal(finalState.attendee.status, "CHECKED_IN", "out-of-order callback must not corrupt final state");
});

test("10. database uniqueness protects against concurrent duplicate scans (race)", async () => {
  await fetch(`${BASE}/api/demo/reset`, { method: "POST" });

  // Fire 5 concurrent scans for the same attendee simultaneously.
  const results = await Promise.all([
    scan("ATT-002", "delayed"),
    scan("ATT-002", "delayed"),
    scan("ATT-002", "delayed"),
    scan("ATT-002", "delayed"),
    scan("ATT-002", "delayed"),
  ]);

  const successCount = results.filter((r) => r.status === 202).length;
  const conflictCount = results.filter((r) => r.status === 409).length;

  assert.equal(successCount, 1, "exactly one scan should succeed in creating a print job");
  assert.equal(conflictCount, 4, "all other concurrent scans must be rejected as in-progress");

  const jobsRes = await fetch(`${BASE}/api/print-jobs`);
  const jobs = (await jobsRes.json()).printJobs.filter((j) => j.attendeeId === "ATT-002");
  const activeJobs = jobs.filter((j) => j.status === "QUEUED" || j.status === "PROCESSING");
  assert.equal(activeJobs.length, 1, "only one active print job must exist for the attendee");
});

test("3-attendee scenario: all three seeded attendees exist and are independently trackable", async () => {
  const res = await fetch(`${BASE}/api/attendees`);
  const data = await res.json();
  const ids = data.attendees.map((a) => a.id).sort();
  assert.deepEqual(ids, ["ATT-001", "ATT-002", "ATT-003"]);
});
