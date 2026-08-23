// server/seed.js
import { db, now } from "./db.js";

const attendees = [
  { id: "ATT-001", name: "Amina Wanjiku", email: "amina@example.com", qr: "ATT-001" },
  { id: "ATT-002", name: "Brian Otieno", email: "brian@example.com", qr: "ATT-002" },
  { id: "ATT-003", name: "David Kamau", email: "david@example.com", qr: "ATT-003" },
];

const insert = db.prepare(
  `INSERT INTO attendees (id, name, email, qr_code, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'REGISTERED', ?, ?)
   ON CONFLICT(id) DO NOTHING`
);

for (const a of attendees) {
  const ts = now();
  insert.run(a.id, a.name, a.email, a.qr, ts, ts);
}

console.log(`Seeded ${attendees.length} attendees.`);
for (const a of attendees) console.log(`  ${a.id} - ${a.name} (${a.email}) QR=${a.qr}`);
