// A small D1 stand-in over node:sqlite. It implements only the surface core.js
// uses and refuses what D1 refuses (BEGIN/COMMIT, numbered parameters,
// undefined bindings, more than 100 bound parameters).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

function check(sql, params) {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) throw new Error('D1 refuses transaction statements: ' + sql.slice(0, 20));
  if (/\?\d/.test(sql)) throw new Error('only ? positional placeholders are allowed');
  if (params.length > 100) throw new Error('too many bound parameters');
  for (const p of params) {
    if (p === undefined) throw new Error('undefined binding');
    if (typeof p === 'object' && p !== null) throw new Error('unsupported binding type');
  }
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  _exec() {
    check(this.sql, this.params);
    const st = this.db.prepare(this.sql);
    const rows = st.all(...this.params);
    const meta = this.db.prepare('SELECT changes() AS c, last_insert_rowid() AS id').get();
    return { success: true, results: rows, meta: { changes: Number(meta.c), last_row_id: Number(meta.id) } };
  }
  async all() {
    return this._exec();
  }
  async first(col) {
    const r = this._exec().results[0] ?? null;
    return col && r ? r[col] : r;
  }
  async run() {
    const r = this._exec();
    return { success: true, meta: r.meta };
  }
}

// Every migration in name order, as `wrangler d1 migrations apply` runs them.
// `upTo` stops after the named file, for tests of a migration itself.
export function makeDb({ upTo } = {}) {
  const raw = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
    if (name === upTo) break;
  }
  return {
    raw,
    prepare: (sql) => new Statement(raw, sql),
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(s._exec());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export const migrationText = (name) => readFileSync(new URL(name, MIGRATIONS), 'utf8');
