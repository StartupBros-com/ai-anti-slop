#!/usr/bin/env node
// Operator CLI for the AI Anti-Slop crowd list server. Uses Node's built-in fetch.
// The token comes from ANTISLOP_ADMIN_TOKEN, else ~/.config/ai-anti-slop/admin-token.
// It is sent only as a bearer header and never printed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `usage: node admin.mjs [--base URL] <command>

  status                          public counts, no token needed
  candidates [--limit N]          accounts with Slop reports, most reported first
  delist <handle> [note]          always remove the account from the list
  clear <handle>                  drop the override, back to the rule
  rebuild                         rebuild the list now

Removal requests need no command: each one delists its account at the next build.

Token: env ANTISLOP_ADMIN_TOKEN, else the file ~/.config/ai-anti-slop/admin-token.
Default base: https://ai-anti-slop.startupbros.com`;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '--limit') {
      if (i + 1 >= argv.length) die(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) {
      die(`unknown flag ${a}\n\n${USAGE}`);
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function token() {
  const env = process.env.ANTISLOP_ADMIN_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const t = readFileSync(join(homedir(), '.config', 'ai-anti-slop', 'admin-token'), 'utf8').trim();
    if (t) return t;
  } catch {}
  return die('no admin token: set ANTISLOP_ADMIN_TOKEN or write ~/.config/ai-anti-slop/admin-token');
}

async function call(base, method, path, { auth = true, body } = {}) {
  const headers = {};
  if (auth) headers.authorization = 'Bearer ' + token();
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(base.replace(/\/+$/, '') + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    return die(`request failed: ${e.cause?.code || e.message}`);
  }
  const text = await res.text();
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  console.log(out);
  if (!res.ok) process.exit(1);
}

const { flags, pos } = parse(process.argv.slice(2));
const base = flags.base || 'https://ai-anti-slop.startupbros.com';
const [cmd, a, b, ...rest] = pos;
const note = (...parts) => {
  const s = parts.filter((x) => x != null).join(' ');
  return s || undefined;
};

switch (cmd) {
  case 'status':
    await call(base, 'GET', '/v1/status', { auth: false });
    break;
  case 'candidates': {
    const limit = flags.limit ? `?limit=${encodeURIComponent(flags.limit)}` : '';
    await call(base, 'GET', '/v1/admin/candidates' + limit);
    break;
  }
  case 'delist':
    if (!a) die('usage: delist <handle> [note]');
    await call(base, 'POST', '/v1/admin/override', { body: { handle: a, action: 'delist', note: note(b, ...rest) } });
    break;
  case 'clear':
    if (!a) die('usage: clear <handle>');
    await call(base, 'POST', '/v1/admin/override', { body: { handle: a, action: 'clear' } });
    break;
  case 'rebuild':
    await call(base, 'POST', '/v1/admin/rebuild', { body: {} });
    break;
  default:
    die(USAGE);
}
