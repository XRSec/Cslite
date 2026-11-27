import type { RunResult, SqlDriver, SqlParam, SqlStatement } from './driver';

interface HranaValue {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob';
  value?: string | number | null;
}

interface HranaResult {
  cols: Array<{ name: string; decltype?: string | null }>;
  rows: HranaValue[][];
  affected_row_count: number;
  last_insert_rowid: string | number | null;
}

interface HranaPipelineResponse {
  results: Array<{
    type: 'ok' | 'error';
    response?: {
      type: string;
      result?: HranaResult;
    };
    error?: {
      message: string;
      code?: string;
    };
  }>;
}

export function normalizeTursoUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('libsql://')) {
    return `https://${trimmed.slice('libsql://'.length)}`;
  }
  return trimmed;
}

export function encodeTursoArgs(params?: SqlParam[]): HranaValue[] {
  if (!params || params.length === 0) return [];
  return params.map((param): HranaValue => {
    if (param === null || param === undefined) {
      return { type: 'null' };
    }
    if (typeof param === 'number') {
      if (!Number.isFinite(param)) {
        return { type: 'null' };
      }
      if (Number.isInteger(param)) {
        return { type: 'integer', value: String(param) };
      }
      return { type: 'float', value: param };
    }
    return { type: 'text', value: String(param) };
  });
}

function decodeCell(cell: HranaValue | undefined): unknown {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer' || cell.type === 'float') {
    return Number(cell.value);
  }
  return cell.value ?? '';
}

function decodeRows<T>(result: HranaResult): T[] {
  const cols = result.cols.map((c) => c.name);
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]!] = decodeCell(row[i]);
    }
    return obj as T;
  });
}

export function createTursoDriver(databaseUrl: string, authToken?: string): SqlDriver {
  const endpoint = `${normalizeTursoUrl(databaseUrl)}/v2/pipeline`;

  async function executePipeline(
    requests: Array<{ type: 'execute'; stmt: { sql: string; args?: HranaValue[] } } | { type: 'close' }>,
  ): Promise<HranaResult[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requests }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Turso HTTP ${res.status}: ${bodyText || res.statusText}`);
    }

    const payload = (await res.json()) as HranaPipelineResponse;
    const out: HranaResult[] = [];
    for (const entry of payload.results ?? []) {
      if (entry.type === 'error') {
        const code = entry.error?.code ? `[${entry.error.code}] ` : '';
        throw new Error(`Turso error: ${code}${entry.error?.message || 'Unknown error'}`);
      }
      if (entry.response?.type === 'execute' && entry.response.result) {
        out.push(entry.response.result);
      }
    }
    return out;
  }

  return {
    dialect: 'sqlite',
    async all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const results = await executePipeline([
        { type: 'execute', stmt: { sql, args: encodeTursoArgs(params) } },
        { type: 'close' },
      ]);
      const first = results[0];
      return first ? decodeRows<T>(first) : [];
    },
    async get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null> {
      const rows = await this.all<T>(sql, params);
      return rows[0] ?? null;
    },
    async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
      const results = await executePipeline([
        { type: 'execute', stmt: { sql, args: encodeTursoArgs(params) } },
        { type: 'close' },
      ]);
      const first = results[0];
      return {
        changes: Number(first?.affected_row_count ?? 0),
        lastInsertRowid:
          first?.last_insert_rowid != null ? Number(first.last_insert_rowid) : undefined,
      };
    },
    async batch(stmts: SqlStatement[]): Promise<RunResult[]> {
      if (stmts.length === 0) return [];
      const requests: Array<
        { type: 'execute'; stmt: { sql: string; args?: HranaValue[] } } | { type: 'close' }
      > = [
        { type: 'execute', stmt: { sql: 'BEGIN' } },
        ...stmts.map((s) => ({
          type: 'execute' as const,
          stmt: { sql: s.sql, args: encodeTursoArgs(s.params) },
        })),
        { type: 'execute', stmt: { sql: 'COMMIT' } },
        { type: 'close' },
      ];
      const results = await executePipeline(requests);
      // Skip results[0] (BEGIN) and results[results.length - 1] (COMMIT)
      const stmtResults = results.slice(1, 1 + stmts.length);
      return stmtResults.map((res) => ({
        changes: Number(res.affected_row_count ?? 0),
        lastInsertRowid:
          res.last_insert_rowid != null ? Number(res.last_insert_rowid) : undefined,
      }));
    },
  };
}
