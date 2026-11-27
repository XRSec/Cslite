import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { RunResult, SqlDriver, SqlParam, SqlStatement } from './driver';

function bindStatement(db: D1Database, sql: string, params?: SqlParam[]): D1PreparedStatement {
  const stmt = db.prepare(sql);
  return params && params.length > 0 ? stmt.bind(...params) : stmt;
}

export function createD1Driver(db: D1Database): SqlDriver {
  return {
    dialect: 'sqlite',
    async all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const res = await bindStatement(db, sql, params).all<T>();
      return (res.results ?? []) as T[];
    },
    async get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null> {
      const row = await bindStatement(db, sql, params).first<T>();
      return row ?? null;
    },
    async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
      const res = await bindStatement(db, sql, params).run();
      return {
        changes: Number(res.meta?.changes ?? 0),
        lastInsertRowid:
          res.meta?.last_row_id != null ? Number(res.meta.last_row_id) : undefined,
      };
    },
    async batch(stmts: SqlStatement[]): Promise<RunResult[]> {
      if (stmts.length === 0) return [];
      const prepared = stmts.map((s) => bindStatement(db, s.sql, s.params));
      const results = await db.batch(prepared);
      return results.map((res) => ({
        changes: Number(res.meta?.changes ?? 0),
        lastInsertRowid:
          res.meta?.last_row_id != null ? Number(res.meta.last_row_id) : undefined,
      }));
    },
  };
}
