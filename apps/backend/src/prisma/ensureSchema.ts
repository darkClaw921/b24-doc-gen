/**
 * ensureSchema — apply the Prisma schema to the configured database on
 * server startup so new models/columns reach the running DB without a
 * manual step.
 *
 * Why this exists:
 *  - The project manages schema changes with `prisma db push` (no
 *    migration files — see the team convention / P3005). That means a
 *    deploy that only `tsc`-builds the backend leaves the production DB
 *    one schema behind, and any route hitting a new table fails with
 *    "table … does not exist" (P2021).
 *  - Running `db push` automatically at boot keeps the DB in sync with
 *    the deployed `schema.prisma` regardless of how the process is
 *    launched (systemd `node dist/server.js`, prod.sh, dev `tsx`).
 *
 * Safety:
 *  - We invoke `prisma db push` WITHOUT `--accept-data-loss`. For purely
 *    additive changes (new table/column) it applies silently; if a
 *    change would drop data it ABORTS with a non-zero exit instead of
 *    destroying anything. We catch that, log loudly and let the server
 *    start anyway, so a risky schema diff never takes the API down and
 *    never silently loses user data.
 *  - `--skip-generate` avoids regenerating the client at runtime (it is
 *    already built into the image).
 *
 * Disable with `DB_AUTO_PUSH=false` (e.g. when migrations are managed
 * out-of-band).
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Resolve the absolute path to the local `prisma` CLI entry script. */
function resolvePrismaCli(): string {
  const require = createRequire(import.meta.url);
  // Resolve via the package.json so we can read the `bin` field instead
  // of guessing the build path across prisma versions.
  const pkgJsonPath = require.resolve('prisma/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binRel =
    typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prisma ?? 'build/index.js';
  return resolve(dirname(pkgJsonPath), binRel);
}

/**
 * Run `prisma db push` against the database in `DATABASE_URL`. Returns
 * true when the schema was applied, false when it was skipped or failed
 * (the caller logs and continues either way).
 */
export function ensureSchema(): boolean {
  if (process.env.DB_AUTO_PUSH === 'false') {
    console.log('[ensureSchema] DB_AUTO_PUSH=false — пропускаю авто-применение схемы');
    return false;
  }

  // This module compiles to dist/prisma/ensureSchema.js (prod) and runs
  // from src/prisma/ensureSchema.ts (dev); both sit two levels under the
  // backend package root.
  const here = dirname(fileURLToPath(import.meta.url));
  const backendDir = resolve(here, '../../');
  const schemaPath = resolve(backendDir, 'prisma', 'schema.prisma');

  let cli: string;
  try {
    cli = resolvePrismaCli();
  } catch {
    console.error(
      '[ensureSchema] prisma CLI не найден — пропускаю авто-применение схемы. ' +
        'Примените изменения вручную: `prisma db push` в apps/backend.',
    );
    return false;
  }

  try {
    console.log('[ensureSchema] применяю схему БД (prisma db push)…');
    execFileSync(
      process.execPath,
      [cli, 'db', 'push', '--skip-generate', '--schema', schemaPath],
      { cwd: backendDir, stdio: 'inherit', env: process.env },
    );
    console.log('[ensureSchema] схема БД актуальна');
    return true;
  } catch (err) {
    // Non-fatal: db push aborts (without --accept-data-loss) rather than
    // dropping data, so a failure here means "schema NOT changed", never
    // "data lost". Keep serving with the existing schema.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ensureSchema] не удалось применить схему автоматически: ${msg}\n` +
        '  Сервер продолжит работу со старой схемой. ' +
        'Если добавлены новые таблицы/поля — примените их вручную: ' +
        '`prisma db push` в apps/backend (бэкап БД сделайте заранее).',
    );
    return false;
  }
}
