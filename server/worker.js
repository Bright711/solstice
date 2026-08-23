// server/worker.js
// -----------------------------------------------------------------------------
// Simulated badge-printer worker. Consumes jobs from printQueue, "prints" for
// a realistic delay, then calls the webhook endpoint over real HTTP — exactly
// like an external badge-printer vendor would call our webhook when a physical
// print completes.
// -----------------------------------------------------------------------------

import { printQueue } from "./queue.js";

const PORT = process.env.PORT || 4000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `http://localhost:${PORT}/api/webhooks/badge-printer`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-webhook-secret";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWebhook(payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": WEBHOOK_SECRET, // simple shared-secret signature for MVP auth
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  console.log(`[WEBHOOK][worker->server] ${payload.printJobId} status=${payload.status} -> HTTP ${res.status}`, json.message || "");
}

async function processJob(job) {
  console.log(`[WORKER] ${job.id} received (attendee ${job.attendeeId}, simulate=${job.simulate})`);

  // "delayed" mode: worker takes noticeably longer before confirming.
  const printTimeMs = job.simulate === "delayed" ? 4000 : 900 + Math.floor(Math.random() * 600);

  console.log(`[PRINTER] ${job.id} printing... (${printTimeMs}ms)`);
  await delay(printTimeMs);

  const success = job.simulate !== "failure";
  const completedAt = new Date().toISOString();

  const payload = {
    printJobId: job.id,
    attendeeId: job.attendeeId,
    status: success ? "SUCCESS" : "FAILED",
    completedAt,
  };

  console.log(`[PRINTER] ${job.id} ${success ? "completed successfully" : "FAILED to print"}`);

  if (job.simulate === "out_of_order" && job.pairedJobId) {
    // Deliberately fire the *paired* later job's callback first to prove the
    // server handles out-of-order arrival correctly. The pairing/orchestration
    // for the demo endpoint lives in index.js; here we just send our own.
    await delay(50);
  }

  await callWebhook(payload);

  if (job.simulate === "duplicate_webhook") {
    // Simulate a flaky vendor retrying the same callback.
    await delay(300);
    console.log(`[WORKER] ${job.id} vendor retry: resending identical webhook`);
    await callWebhook(payload);
  }
}

printQueue.registerConsumer(processJob);

console.log("[WORKER] Badge printer worker registered and listening on queue.");
