import { makeDb } from './d1shim.mjs';
import { handle, build, RULES } from '../src/core.js';

export const SECRET = 'test-hmac-secret-value';
export const ADMIN = 'test-admin-token-value';
export const HOUR = 3600000;
export const DAY = 86400000;
// An hour-aligned instant, so report times and install ages are exact.
export const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

export const keyOf = (i) => i.toString(16).padStart(32, '0');
export { RULES, build };

export function world(envOver = {}) {
  const db = makeDb();
  const env = { DB: db, HMAC_SECRET: SECRET, ADMIN_TOKEN: ADMIN, ...envOver };
  async function req(method, path, { body, ip, now = T0, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (ip) h['CF-Connecting-IP'] = ip;
    let b = raw;
    if (b === undefined && body !== undefined) {
      b = JSON.stringify(body);
      h['content-type'] ??= 'text/plain;charset=UTF-8';
    }
    const res = await handle(new Request('https://t.example' + path, { method, body: b, headers: h }), env, now);
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    return { res, status: res.status, text, json: j };
  }
  const report = (i, items, opts = {}) =>
    req('POST', '/v1/reports', { body: { v: 1, key: keyOf(i), reports: items }, ...opts });
  const admin = (method, path, body, now = T0) =>
    req(method, path, { body, now, headers: { authorization: 'Bearer ' + ADMIN } });
  const buildAt = (now = T0) => build(db, env, now);
  const body = async (now = T0) => (await req('GET', '/v1/list.ndjson', { now })).text;
  const count = (sql, ...p) => Number(db.raw.prepare(sql).get(...p).c);
  return { db, env, req, report, admin, buildAt, body, count };
}

// Report one account as slop from `n` installs, each in its own thread, over `nets` networks.
// Installs register at `when` (so they are aged by the time of a later build).
export async function slopFrom(w, handleName, ids, { when, nets = 3, threads } = {}) {
  let k = 0;
  for (const i of ids) {
    const r = await w.report(
      i,
      [{ label: 'slop', handle: handleName, status: String(1000 + i), thread: String(threads ? 500 + (k % threads) : 500 + k) }],
      { now: when, ip: `10.0.${i % nets}.5` },
    );
    if (r.status !== 200) throw new Error('setup failed ' + r.text);
    k++;
  }
}
