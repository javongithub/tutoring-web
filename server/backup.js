// Consistent snapshot of the live database (safe while the server runs). Keeps the newest 14.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { today } from './lib/time.js';

const file = process.env.DB_PATH || 'data/tutoring.db';
const dir = join(dirname(file), 'backups');
mkdirSync(dir, { recursive: true });
const out = join(dir, `tutoring-${today()}.db`);
rmSync(out, { force: true });
openDb(file).exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
const all = readdirSync(dir).filter((f) => /^tutoring-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
for (const old of all.slice(0, -14)) rmSync(join(dir, old));
console.log(`Backed up to ${out}`);
