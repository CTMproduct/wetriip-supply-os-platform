#!/usr/bin/env node
/**
 * Populate ARI through the REAL pipeline.
 *
 * Calls the platform's own API to run a pull on every connection, so inventory
 * arrives the way a channel manager's inventory actually arrives: adapter ->
 * canonical events -> ledger (with dedupe and ordering) -> layer cells ->
 * Effective ARI -> events.
 *
 * Seeding the tables directly would be faster and would prove nothing.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3100';
const EMAIL = process.env.SEED_USER || 'ops@wetriip.ai';

async function json(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });
  const login = await json(loginRes);
  if (!loginRes.ok) {
    console.error('login failed:', login);
    process.exit(1);
  }
  const auth = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
  console.log(`> signed in as ${login.claims.email} (${login.claims.role})`);

  const health = await json(await fetch(`${BASE}/api/v1/connectivity/health`, { headers: auth }));
  if (!Array.isArray(health)) {
    console.error('could not read connectivity health:', health);
    process.exit(1);
  }

  const today = new Date();
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 60 * 86400000).toISOString().slice(0, 10);

  for (const conn of health) {
    process.stdout.write(`  . pulling ${conn.propertyName} (${conn.provider}) ${from}..${to} ... `);
    const res = await fetch(
      `${BASE}/api/v1/connectivity/connections/${conn.connectionId}/pull`,
      { method: 'POST', headers: auth, body: JSON.stringify({ from, to }) },
    );
    const body = await json(res);
    if (!res.ok) {
      console.log('FAILED');
      console.log('    ', body?.error?.code, body?.error?.message);
      continue;
    }
    console.log(
      `fetched ${body.fetched}, accepted ${body.ingest?.accepted}, duplicates ${body.ingest?.duplicates}, cells ${body.ingest?.cellsTouched}`,
    );
  }

  console.log('> ARI bootstrap complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
