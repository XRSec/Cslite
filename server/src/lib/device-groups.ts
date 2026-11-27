import type { SqlDriver, SqlStatement } from '../db/driver';

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Loads ordered group_ids per device from device_groups.
 */
export async function loadDeviceGroupIdsMap(
  driver: SqlDriver,
  deviceIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const cleanIds = uniqueStrings(deviceIds);
  if (cleanIds.length === 0) return map;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = await driver.all<{ device_id: string; group_id: string }>(
    `SELECT device_id, group_id FROM device_groups WHERE device_id IN (${placeholders}) ORDER BY created_at ASC, group_id ASC`,
    cleanIds,
  );
  for (const r of rows) {
    const list = map.get(r.device_id) ?? [];
    if (!list.includes(r.group_id)) list.push(r.group_id);
    map.set(r.device_id, list);
  }
  return map;
}

/**
 * Loads ordered member device_ids per group from device_groups.
 */
export async function loadGroupDeviceIdsMap(
  driver: SqlDriver,
  groupIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const cleanIds = uniqueStrings(groupIds);
  if (cleanIds.length === 0) return map;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = await driver.all<{ group_id: string; device_id: string }>(
    `SELECT group_id, device_id FROM device_groups WHERE group_id IN (${placeholders}) ORDER BY created_at ASC, device_id ASC`,
    cleanIds,
  );
  for (const r of rows) {
    const list = map.get(r.group_id) ?? [];
    if (!list.includes(r.device_id)) list.push(r.device_id);
    map.set(r.group_id, list);
  }
  return map;
}

/**
 * Builds SQL statements to replace all group memberships for a single device.
 */
export function buildReplaceDeviceGroupsStmts(
  driver: SqlDriver,
  deviceId: string,
  groupIds: string[],
  nowIso: string,
): SqlStatement[] {
  const clean = uniqueStrings(groupIds);
  const insertVerb = driver.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  const stmts: SqlStatement[] = [
    { sql: 'DELETE FROM device_groups WHERE device_id = ?', params: [deviceId] },
  ];
  for (const gid of clean) {
    stmts.push({
      sql: `${insertVerb} INTO device_groups (device_id, group_id, created_at) VALUES (?, ?, ?)`,
      params: [deviceId, gid, nowIso],
    });
  }
  return stmts;
}

/**
 * Builds SQL statements to add devices to a group while preserving existing group bindings.
 */
export function buildAddDevicesToGroupStmts(
  driver: SqlDriver,
  groupId: string,
  deviceIds: string[],
  nowIso: string,
): SqlStatement[] {
  const clean = uniqueStrings(deviceIds);
  const insertVerb = driver.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  const stmts: SqlStatement[] = [];
  for (const devId of clean) {
    stmts.push({
      sql: `${insertVerb} INTO device_groups (device_id, group_id, created_at) VALUES (?, ?, ?)`,
      params: [devId, groupId, nowIso],
    });
    stmts.push({
      sql: "UPDATE devices SET group_id = COALESCE(NULLIF(group_id, ''), ?), updated_at = ? WHERE id = ?",
      params: [groupId, nowIso, devId],
    });
  }
  return stmts;
}

/**
 * Recomputes devices.group_id as the first remaining group_id in device_groups (or NULL).
 */
export async function syncDevicesPrimaryGroup(
  driver: SqlDriver,
  deviceIds: string[],
  nowIso: string,
): Promise<void> {
  const clean = uniqueStrings(deviceIds);
  if (clean.length === 0) return;
  const map = await loadDeviceGroupIdsMap(driver, clean);
  const stmts: SqlStatement[] = clean.map((devId) => {
    const firstGroup = map.get(devId)?.[0] ?? null;
    return {
      sql: 'UPDATE devices SET group_id = ?, updated_at = ? WHERE id = ?',
      params: [firstGroup, nowIso, devId],
    };
  });
  await driver.batch(stmts);
}
