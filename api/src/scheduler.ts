// Background jobs. Checks once a minute; each project's daily sheet export runs once per day
// at or after its configured hour (in config.timezone). A failed run is not retried until the next day.
import { systemCtx } from './auth.js';
import { config } from './config.js';
import { one, pool, q } from './db.js';
import { runExport } from './services/sheet-export.js';

function localParts(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** True when the export is due now. Exported for tests. */
export function exportDue(now: Date, hour: number, lastRun: Date | null) {
  const n = localParts(now);
  if (n.hour < hour) return false;
  return !lastRun || localParts(lastRun).date < n.date;
}

async function tick(log: (m: string) => void) {
  const projects = await q<{ id: string; key: string; sheet_export_hour: number; sheet_export_last_run_at: Date | null }>(
    `select id, key, sheet_export_hour, sheet_export_last_run_at from projects
      where sheet_export_enabled and sheet_export_id is not null and archived_at is null`,
  );
  for (const p of projects) {
    if (!exportDue(new Date(), p.sheet_export_hour, p.sheet_export_last_run_at)) continue;
    const c = await pool.connect();
    try {
      // Only one API instance runs a given export.
      const { locked } = (await c.query(`select pg_try_advisory_lock(hashtext($1)) as locked`, [`sheet-export:${p.id}`])).rows[0];
      if (!locked) continue;
      const fresh = await one<{ sheet_export_last_run_at: Date | null }>(`select sheet_export_last_run_at from projects where id = $1`, [p.id]);
      if (!exportDue(new Date(), p.sheet_export_hour, fresh?.sheet_export_last_run_at ?? null)) continue;
      log(`daily sheet export for ${p.key} starting`);
      await runExport(systemCtx(), p.id);
      log(`daily sheet export for ${p.key} finished`);
    } catch (e: any) {
      log(`daily sheet export for ${p.key} failed: ${e?.message ?? e}`);
    } finally {
      await c.query(`select pg_advisory_unlock(hashtext($1))`, [`sheet-export:${p.id}`]).catch(() => {});
      c.release();
    }
  }
}

export function startScheduler(log: (m: string) => void) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(log);
    } catch (e: any) {
      log(`scheduler error: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 15_000);
  return setInterval(run, 60_000);
}
