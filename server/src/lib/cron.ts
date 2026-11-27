export class CronValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronValidationError';
  }
}

export interface CronSchedule {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseNumberOrAlias(
  token: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): number {
  const lower = token.trim().toLowerCase();
  if (aliases && lower in aliases) {
    return aliases[lower]!;
  }
  if (!/^\d+$/.test(lower)) {
    throw new CronValidationError(`Invalid cron token: "${token}"`);
  }
  const num = Number.parseInt(lower, 10);
  if (num < min || num > max) {
    throw new CronValidationError(`Cron value ${num} out of range [${min}, ${max}]`);
  }
  return num;
}

function parseField(
  field: string,
  min: number,
  max: number,
  options: { aliases?: Record<string, number>; normalize?: (n: number) => number } = {},
): { values: Set<number>; isWildcard: boolean } {
  const trimmed = field.trim();
  if (!trimmed) {
    throw new CronValidationError('Empty cron field');
  }
  const isWildcard = trimmed === '*';
  const values = new Set<number>();

  for (const part of trimmed.split(',')) {
    if (!part) {
      throw new CronValidationError(`Empty list item in cron field "${field}"`);
    }
    const stepSplit = part.split('/');
    if (stepSplit.length > 2) {
      throw new CronValidationError(`Invalid step syntax in "${part}"`);
    }
    const rangePart = stepSplit[0]!;
    let step = 1;
    if (stepSplit.length === 2) {
      const stepStr = stepSplit[1]!;
      if (!/^\d+$/.test(stepStr)) {
        throw new CronValidationError(`Invalid step "${stepStr}" in "${part}"`);
      }
      step = Number.parseInt(stepStr, 10);
      if (step <= 0) {
        throw new CronValidationError(`Cron step must be > 0 in "${part}"`);
      }
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
        throw new CronValidationError(`Invalid range "${rangePart}"`);
      }
      start = parseNumberOrAlias(bounds[0], min, max, options.aliases);
      end = parseNumberOrAlias(bounds[1], min, max, options.aliases);
      if (start > end) {
        throw new CronValidationError(`Cron range start > end in "${rangePart}"`);
      }
    } else {
      start = parseNumberOrAlias(rangePart, min, max, options.aliases);
      end = stepSplit.length === 2 ? max : start;
    }

    for (let v = start; v <= end; v += step) {
      const normalized = options.normalize ? options.normalize(v) : v;
      values.add(normalized);
    }
  }

  if (values.size === 0) {
    throw new CronValidationError(`Cron field "${field}" matched no values`);
  }

  return { values, isWildcard };
}

function daysInUtcMonth(year: number, month1To12: number): number {
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate();
}

/**
 * Validates and parses a 5-field UTC cron expression:
 * `minute hour day-of-month month day-of-week`.
 */
export function parseCron(expr: string): CronSchedule {
  if (typeof expr !== 'string') {
    throw new CronValidationError('Cron expression must be a string');
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronValidationError(`Expected 5 cron fields, got ${fields.length}`);
  }

  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12, { aliases: MONTH_NAMES });
  const dow = parseField(fields[4]!, 0, 7, {
    aliases: DOW_NAMES,
    normalize: (n) => (n === 7 ? 0 : n),
  });

  if (dow.isWildcard) {
    let anyValidDate = false;
    for (const m of month.values) {
      const maxDays = daysInUtcMonth(2024, m); // leap year allows Feb 29
      for (const d of dom.values) {
        if (d <= maxDays) {
          anyValidDate = true;
          break;
        }
      }
      if (anyValidDate) break;
    }
    if (!anyValidDate) {
      throw new CronValidationError(`Impossible month/day combination in "${expr}"`);
    }
  }

  return {
    raw: expr.trim(),
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domWildcard: dom.isWildcard,
    dowWildcard: dow.isWildcard,
  };
}

function dayMatches(schedule: CronSchedule, dom: number, dow: number): boolean {
  if (schedule.domWildcard && schedule.dowWildcard) return true;
  if (schedule.domWildcard) return schedule.daysOfWeek.has(dow);
  if (schedule.dowWildcard) return schedule.daysOfMonth.has(dom);
  return schedule.daysOfMonth.has(dom) || schedule.daysOfWeek.has(dow);
}

/**
 * Computes the next UTC ISO-8601 execution timestamp strictly after `afterDate`.
 */
export function nextCronAfter(
  scheduleOrExpr: CronSchedule | string,
  afterDate: Date = new Date(),
): string {
  const schedule =
    typeof scheduleOrExpr === 'string' ? parseCron(scheduleOrExpr) : scheduleOrExpr;

  const cursor = new Date(
    Date.UTC(
      afterDate.getUTCFullYear(),
      afterDate.getUTCMonth(),
      afterDate.getUTCDate(),
      afterDate.getUTCHours(),
      afterDate.getUTCMinutes() + 1,
      0,
      0,
    ),
  );

  const maxYear = afterDate.getUTCFullYear() + 8;

  while (cursor.getUTCFullYear() <= maxYear) {
    const month = cursor.getUTCMonth() + 1;
    if (!schedule.months.has(month)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dom = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    if (!dayMatches(schedule, dom, dow)) {
      cursor.setUTCDate(dom + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!schedule.hours.has(hour)) {
      cursor.setUTCHours(hour + 1, 0, 0, 0);
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!schedule.minutes.has(minute)) {
      cursor.setUTCMinutes(minute + 1, 0, 0);
      continue;
    }

    return cursor.toISOString();
  }

  throw new CronValidationError(`No upcoming run found within 8 years for "${schedule.raw}"`);
}
