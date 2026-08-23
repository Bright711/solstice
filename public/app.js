const API = "";

// ---------------- tab switching ----------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`view-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "admin") loadDashboard();
  });
});

// ---------------- toast ----------------
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden", "error");
  if (isError) el.classList.add("error");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---------------- kiosk: test attendee buttons ----------------
const TEST_ATTENDEES = [
  { id: "ATT-001", name: "Amina Wanjiku", qr: "ATT-001" },
  { id: "ATT-002", name: "Brian Otieno", qr: "ATT-002" },
  { id: "ATT-003", name: "David Kamau", qr: "ATT-003" },
];

const testButtonsEl = document.getElementById("testButtons");
TEST_ATTENDEES.forEach((a) => {
  const btn = document.createElement("button");
  btn.className = "attendee-btn";
  btn.innerHTML = `
    <span>
      <span class="ab-name">${a.name}</span><br/>
      <span class="ab-meta">${a.id}</span>
    </span>
    <span class="ab-tag">Scan</span>
  `;
  btn.addEventListener("click", () => performScan(a.qr));
  testButtonsEl.appendChild(btn);
});

document.getElementById("manualScanForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const val = document.getElementById("manualQr").value.trim();
  if (!val) return;
  performScan(val);
});

// ---------------- kiosk: scan + poll flow ----------------
let pollTimer = null;

function setResultVisible(v) {
  document.getElementById("resultEmpty").classList.toggle("hidden", v);
  document.getElementById("resultCard").classList.toggle("hidden", !v);
}

function renderResult({ name, email, status, badgeText, jobId, message }) {
  setResultVisible(true);
  document.getElementById("rName").textContent = name || "—";
  document.getElementById("rEmail").textContent = email || "—";
  const pill = document.getElementById("rStatusPill");
  pill.textContent = status;
  pill.className = `status-pill ${status}`;
  document.getElementById("rBadgeText").textContent = badgeText;
  document.getElementById("rJobId").textContent = jobId || "—";
  document.getElementById("rMessage").textContent = message || "—";
  document.getElementById("progressTrack").classList.toggle("active", status === "PENDING");
}

async function performScan(qrCode) {
  if (pollTimer) clearInterval(pollTimer);
  const simulate = document.getElementById("simulateSelect").value;

  try {
    const res = await fetch(`${API}/api/check-in/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qrCode, simulate }),
    });
    const data = await res.json();

    if (!data.attendee) {
      toast(data.message || "Unknown QR code", true);
      return;
    }

    if (data.status === "CHECKED_IN" && !data.success) {
      renderResult({
        name: data.attendee.name,
        email: data.attendee.email,
        status: "CHECKED_IN",
        badgeText: "Badge printed successfully",
        message: data.message,
      });
      toast(data.message, true);
      return;
    }

    if (data.status === "PENDING" && !data.success) {
      renderResult({
        name: data.attendee.name,
        email: data.attendee.email,
        status: "PENDING",
        badgeText: "Printing…",
        jobId: data.printJob?.id,
        message: data.message,
      });
      toast(data.message, true);
      pollAttendee(data.attendee.id);
      return;
    }

    // success = 202, new job created
    renderResult({
      name: data.attendee.name,
      email: data.attendee.email,
      status: "PENDING",
      badgeText: "Printing…",
      jobId: data.printJob?.id,
      message: data.message,
    });
    pollAttendee(data.attendee.id);
  } catch (err) {
    toast("Network error contacting server", true);
    console.error(err);
  }
}

function pollAttendee(attendeeId) {
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/attendees/${attendeeId}`);
      const data = await res.json();
      const a = data.attendee;
      if (!a) return;

      if (a.status === "PENDING") return; // keep waiting

      clearInterval(pollTimer);

      if (a.status === "CHECKED_IN") {
        renderResult({
          name: a.name,
          email: a.email,
          status: "CHECKED_IN",
          badgeText: "Badge printed successfully",
          jobId: data.printJob?.id,
          message: "Attendee checked in.",
        });
        toast(`${a.name} checked in`);
      } else if (a.status === "FAILED") {
        renderResult({
          name: a.name,
          email: a.email,
          status: "FAILED",
          badgeText: "Badge printing failed",
          jobId: data.printJob?.id,
          message: "Printer reported a failure. Re-scan to retry.",
        });
        toast("Badge printing failed", true);
      }
    } catch (err) {
      console.error(err);
    }
  }, 700);
}

// ---------------- admin dashboard ----------------
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function loadDashboard() {
  try {
    const res = await fetch(`${API}/api/dashboard`);
    const data = await res.json();

    const stats = [
      ["Total attendees", data.totals.total],
      ["Checked in", data.totals.checkedIn],
      ["Pending", data.totals.pending],
      ["Failed", data.totals.failed],
      ["Registered", data.totals.registered],
    ];
    document.getElementById("statRow").innerHTML = stats
      .map(([label, num]) => `<div class="stat-card"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`)
      .join("");

    const tbody = document.querySelector("#attendeeTable tbody");
    tbody.innerHTML = data.attendees
      .map(
        (a) => `
      <tr>
        <td>${a.name}<br/><span class="muted" style="font-size:0.78rem">${a.id}</span></td>
        <td>${a.email}</td>
        <td><span class="mini-pill ${a.status}">${a.status}</span></td>
        <td>${a.lastPrintJobId ? `${a.lastPrintJobId}<br/><span class="muted" style="font-size:0.78rem">${a.lastPrintJobStatus || ""}</span>` : "—"}</td>
        <td>${fmtTime(a.updatedAt)}</td>
      </tr>`
      )
      .join("");

    document.getElementById("queueInfo").innerHTML = `
      <div>In-memory queue depth: <strong>${data.queue.inMemoryQueueDepth}</strong></div>
      <div>Active jobs in DB (QUEUED/PROCESSING): <strong>${data.queue.pendingJobsInDb}</strong></div>
    `;

    document.getElementById("recentJobs").innerHTML =
      data.recentPrintJobs.map((j) => `<div>${j.id} — ${j.status} — ${j.attendeeId} — ${fmtTime(j.updatedAt)}</div>`).join("") ||
      "<div>No print jobs yet.</div>";

    document.getElementById("recentEvents").innerHTML =
      data.recentWebhookEvents
        .map((e) => `<div>${e.printJobId} — ${e.status}${e.applied ? "" : " (dup/ignored)"} — ${fmtTime(e.receivedAt)}</div>`)
        .join("") || "<div>No webhook events yet.</div>";
  } catch (err) {
    console.error(err);
  }
}

document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
document.getElementById("resetBtn").addEventListener("click", async () => {
  await fetch(`${API}/api/demo/reset`, { method: "POST" });
  toast("Demo data reset");
  loadDashboard();
  setResultVisible(false);
});

// auto-refresh admin view while visible
setInterval(() => {
  if (document.getElementById("view-admin").classList.contains("active")) loadDashboard();
}, 4000);
