export type SqlParam = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlParam[];
}

export interface RunResult {
  changes: number;
  lastInsertRowid?: number;
}

export interface SqlDriver {
  readonly dialect: 'sqlite' | 'mysql';
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;
  run(sql: string, params?: SqlParam[]): Promise<RunResult>;
  batch(stmts: SqlStatement[]): Promise<RunResult[]>;
  close?(): Promise<void>;
}
