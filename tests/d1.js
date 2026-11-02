// A D1-shaped wrapper over node:sqlite, just enough for the Worker:
// prepare(sql).bind(...).first() / .all() / .run(), and batch([...]) run as
// one transaction. Rows come back as plain objects, like D1 returns them.
import { DatabaseSync } from 'node:sqlite';

export function openDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  return new D1(sqlite);
}

class D1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new Statement(this.sqlite, sql, []);
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.execute());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  // Test helper, not part of D1: run raw SQL (several statements allowed).
  exec(sql) {
    this.sqlite.exec(sql);
  }
}

class Statement {
  constructor(sqlite, sql, params) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.sqlite, this.sql, params.map((p) => (p === undefined ? null : p)));
  }

  // Shared by all(), run() and batch(): returns D1's { results, meta }.
  execute() {
    const stmt = this.sqlite.prepare(this.sql);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) {
      const results = stmt.all(...this.params).map((row) => ({ ...row }));
      return { success: true, results, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = stmt.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  async first(column) {
    const row = this.execute().results[0] ?? null;
    if (row && column !== undefined) return row[column] ?? null;
    return row;
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }
}
