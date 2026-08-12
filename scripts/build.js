#!/usr/bin/env node
/**
 * Ordered workspace build.
 *
 * Packages must be built before services because services resolve
 * `@wetriip/*` through the workspace symlink into `<pkg>/dist`.
 * npm workspaces has no topological build, so we own the order here.
 *
 * Invoked via `node scripts/build.js [packages|services|all]` — never npx:
 * the OneDrive path in this environment breaks .cmd shims.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// Dependency order is explicit and reviewed, not inferred.
const PACKAGES = [
  'contracts',
  'observability',
  'domain',
  'bus',
  'persistence',
  'connectivity-sdk',
  'service-kit',
];

const SERVICES = [
  'core-commerce',
  'ari-ingestion',
  'connectivity',
  'search',
  'booking',
  'groups',
  'agent',
  'reconciliation',
  'gateway',
  'all-in-one',
];

function build(kind, name) {
  const dir = path.join(ROOT, kind, name);
  if (!fs.existsSync(path.join(dir, 'tsconfig.json'))) {
    console.log(`  . skip ${kind}/${name} (no tsconfig)`);
    return;
  }
  process.stdout.write(`  . ${kind}/${name} ... `);
  try {
    execFileSync(process.execPath, [TSC, '-p', path.join(dir, 'tsconfig.json')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.log('FAILED');
    process.stdout.write(String(err.stdout || ''));
    process.stderr.write(String(err.stderr || ''));
    process.exit(1);
  }
  console.log('ok');
}

const target = process.argv[2] || 'all';

if (target === 'packages' || target === 'all') {
  console.log('> packages');
  PACKAGES.forEach((p) => build('packages', p));
}
if (target === 'services' || target === 'all') {
  console.log('> services');
  SERVICES.forEach((s) => build('services', s));
}
console.log('build complete');
