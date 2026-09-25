// Load clients, weekly schedules, availability and blocked times from a JSON file.
//   npm run seed                  -> data/seed.local.json if present, else server/seed.example.json
//   npm run seed -- path.json     -> a specific file
//   add --force to wipe existing students/sessions first
// Keep real client data in data/ (gitignored) — never commit it.
import { existsSync, readFileSync } from 'node:fs';
import { type CountRow } from './types.ts';
import { openDb, newToken, scalar, tx } from './db.ts';

interface SeedFile {
  settings?: Record<string, string | number>;
  availability?: { weekday: number; start_time: string; end_time: string }[];
  blocks?: { label: string; weekday: number; start_time: string; end_time: string }[];
  students?: {
    name: string; parent_name?: string; email?: string; phone?: string; grade?: string; subject?: string;
    rate_cents?: number; notes?: string;
    schedule?: { weekday: number; start_time: string; duration_min?: number; starts_on?: string }[];
  }[];
}
import { materializeRecurring } from './lib/schedule.ts';
import { today } from './lib/time.ts';

const args = process.argv.slice(2);
const force = args.includes('--force');
const file = args.find((a) => !a.startsWith('--'))
  || (existsSync('data/seed.local.json') ? 'data/seed.local.json' : 'server/seed.example.json');
const data = JSON.parse(readFileSync(file, 'utf8')) as SeedFile;
const db = openDb();

const count = scalar<CountRow>(db, 'SELECT COUNT(*) AS n FROM students').n;
if (count && !force) {
  console.error(`Database already has ${count} students. Re-run with --force to wipe and reseed.`);
  process.exit(1);
}

tx(db, () => {
  if (force) db.exec('DELETE FROM sessions; DELETE FROM recurring; DELETE FROM students; DELETE FROM availability; DELETE FROM blocks;');
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(data.settings || {})) set.run(k, String(v));
  const av = db.prepare('INSERT INTO availability (weekday, start_time, end_time) VALUES (?, ?, ?)');
  for (const a of data.availability || []) av.run(a.weekday, a.start_time, a.end_time);
  const bl = db.prepare('INSERT INTO blocks (label, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
  for (const b of data.blocks || []) bl.run(b.label, b.weekday, b.start_time, b.end_time);
  const rate = Number(data.settings?.default_rate_cents ?? 3000);
  const st = db.prepare(
    `INSERT INTO students (name, parent_name, email, phone, grade, subject, rate_cents, notes, portal_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rule = db.prepare('INSERT INTO recurring (student_id, weekday, start_time, duration_min, starts_on) VALUES (?, ?, ?, ?, ?)');
  for (const s of data.students || []) {
    const id = st.run(s.name, s.parent_name || '', s.email || '', s.phone || '', s.grade || '', s.subject || '',
      s.rate_cents ?? rate, s.notes || '', newToken()).lastInsertRowid;
    for (const r of s.schedule || []) rule.run(id, r.weekday, r.start_time, r.duration_min || 60, r.starts_on || today());
  }
});
materializeRecurring(db);
const n = scalar<CountRow>(db, 'SELECT COUNT(*) AS n FROM sessions').n;
console.log(`Seeded from ${file}: ${(data.students || []).length} students, ${n} sessions scheduled.`);
