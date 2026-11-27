import type { RunResult, SqlDriver, SqlParam, SqlStatement } from './driver';

function assertMinNodeVersion(): void {
  const [majorStr = '0', minorStr = '0'] = process.versions.node.split('.');
  const major = Number.parseInt(majorStr, 10);
  const minor = Number.parseInt(minorStr, 10);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`node:sqlite requires Node.js >= 22.5.0 (current: ${process.versions.node})`);
  }
}

export async function createNodeSqliteDriver(dbPath: string): Promise<SqlDriver> {
  assertMinNodeVersion();

  if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    const [{ mkdir }, { dirname }] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    await mkdir(dirname(dbPath), { recursive: true });
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

  return {
    dialect: 'sqlite',
    async all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all();
      return rows.map((row) => ({ ...row })) as T[];
    },
    async get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = params && params.length > 0 ? stmt.get(...params) : stmt.get();
      return row ? ({ ...row } as T) : null;
    },
    async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
      const stmt = db.prepare(sql);
      const res = params && params.length > 0 ? stmt.run(...params) : stmt.run();
      return {
        changes: Number(res.changes),
        lastInsertRowid:
          res.lastInsertRowid != null ? Number(res.lastInsertRowid) : undefined,
      };
    },
    async batch(stmts: SqlStatement[]): Promise<RunResult[]> {
      if (stmts.length === 0) return [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const out: RunResult[] = [];
        for (const s of stmts) {
          const stmt = db.prepare(s.sql);
          const res = s.params && s.params.length > 0 ? stmt.run(...s.params) : stmt.run();
          out.push({
            changes: Number(res.changes),
            lastInsertRowid:
              res.lastInsertRowid != null ? Number(res.lastInsertRowid) : undefined,
          });
        }
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore secondary rollback failure
        }
        throw err;
      }
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}
