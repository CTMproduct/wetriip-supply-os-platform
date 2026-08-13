#!/usr/bin/env node
/**
 * Release step. Runs on every deploy, before the process starts serving.
 *
 * Three jobs, in this order and no other:
 *
 *   1. Apply migrations. `migrate deploy` only ever plays forward — it never
 *      prompts, never resets, and never drops. `migrate dev` is the interactive
 *      one and must never touch a deployed database.
 *   2. Seed, but only when asked. A deploy that silently reseeds is a deploy
 *      that silently discards whatever the demo user just did.
 *   3. Say out loud what kind of deployment this is. A public URL with the
 *      development sign-in switched on is the single most important fact about
 *      an environment, and it belongs in the deploy log where an operator sees
 *      it — not only on the login screen where only visitors do.
 */
const { spawnSync } = require('node:child_process');

// Railway injects env vars into the process. Locally they live in .env, and a
// release step that behaves differently in the two places is a release step
// nobody can rehearse.
try {
  require('dotenv').config();
} catch {
  // dotenv is a dev convenience; its absence is not an error in a deployment.
}

function run(label, args) {
  process.stdout.write(`> ${label}\n`);
  const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    process.stderr.write(`\n! ${label} failed with exit code ${res.status}\n`);
    process.exit(res.status ?? 1);
  }
}

if (!process.env.DATABASE_URL) {
  process.stderr.write(
    '\n! DATABASE_URL is not set.\n' +
      '  On Railway, add a Postgres service and reference it as\n' +
      '  DATABASE_URL=${{Postgres.DATABASE_URL}} on this service.\n\n',
  );
  process.exit(1);
}

run('applying migrations', [
  'node_modules/prisma/build/index.js',
  'migrate',
  'deploy',
  '--schema',
  'packages/persistence/prisma/schema.prisma',
]);

if (process.env.SEED_ON_DEPLOY === 'true') {
  run('seeding demo data', [
    'node_modules/ts-node/dist/bin.js',
    '--project',
    'tsconfig.base.json',
    'packages/persistence/prisma/seed.ts',
  ]);
} else {
  process.stdout.write('> skipping seed (set SEED_ON_DEPLOY=true to load demo data)\n');
}

/* ── The posture, in the deploy log ───────────────────────── */
const open = process.env.DEV_LOGIN_ENABLED === 'true';
const oidc = Boolean(process.env.OIDC_ISSUER);

if (open && !oidc) {
  process.stdout.write(
    '\n' +
      '  ┌─────────────────────────────────────────────────────────────┐\n' +
      '  │  THIS DEPLOYMENT HAS NO AUTHENTICATION                      │\n' +
      '  │                                                             │\n' +
      '  │  DEV_LOGIN_ENABLED=true accepts any seeded email address    │\n' +
      '  │  with no credential. The seeded addresses are published in  │\n' +
      '  │  the README. Anyone with the URL can sign in as the         │\n' +
      '  │  platform administrator.                                    │\n' +
      '  │                                                             │\n' +
      '  │  Fine for a demo with seed data. Never for real hotels,     │\n' +
      '  │  real rates or real bookings.                               │\n' +
      '  └─────────────────────────────────────────────────────────────┘\n\n',
  );
} else if (!open && !oidc) {
  process.stdout.write(
    '> sign-in is closed: no identity provider, and the development login is off.\n' +
      '  Set DEV_LOGIN_ENABLED=true for a demo, or OIDC_ISSUER for a real deployment.\n',
  );
}

process.stdout.write('> release complete\n');
