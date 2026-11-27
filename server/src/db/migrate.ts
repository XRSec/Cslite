import type { AppConfig } from '../config';
import { hashPassword } from '../lib/crypto';
import type { SqlDriver } from './driver';
import { MYSQL_DDL_STATEMENTS, SQLITE_DDL_STATEMENTS } from './schema';

const migratedDrivers = new WeakMap<SqlDriver, Promise<void>>();

/**
 * Adds device_id and key_secret columns + index to pre-existing api_keys tables.
 * MySQL 8.4 does not support ADD COLUMN IF NOT EXISTS or CREATE INDEX IF NOT EXISTS,
 * so metadata tables are queried before issuing ALTER TABLE statements.
 */
export async function ensureApiKeyDeviceColumns(driver: SqlDriver): Promise<void> {
  if (driver.dialect === 'mysql') {
    const colRows = await driver.all<{ COLUMN_NAME?: string; column_name?: string }>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_keys'",
    );
    const existingCols = new Set(
      colRows
        .map((r) => String(r.COLUMN_NAME ?? r.column_name ?? '').toLowerCase())
        .filter(Boolean),
    );
    if (!existingCols.has('device_id')) {
      await driver.run('ALTER TABLE api_keys ADD COLUMN device_id VARCHAR(64) NULL');
    }
    if (!existingCols.has('key_secret')) {
      await driver.run('ALTER TABLE api_keys ADD COLUMN key_secret VARCHAR(512) NULL');
    }
    const idxRow = await driver.get<{ INDEX_NAME?: string; index_name?: string }>(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_keys' AND INDEX_NAME = 'idx_api_keys_device_id' LIMIT 1",
    );
    if (!idxRow) {
      await driver.run('ALTER TABLE api_keys ADD INDEX idx_api_keys_device_id (device_id)');
    }
    return;
  }

  const colRows = await driver.all<{ name?: string }>('PRAGMA table_info(api_keys)');
  const existingCols = new Set(
    colRows.map((r) => String(r.name ?? '').toLowerCase()).filter(Boolean),
  );
  if (!existingCols.has('device_id')) {
    await driver.run('ALTER TABLE api_keys ADD COLUMN device_id TEXT');
  }
  if (!existingCols.has('key_secret')) {
    await driver.run('ALTER TABLE api_keys ADD COLUMN key_secret TEXT');
  }
  await driver.run('CREATE INDEX IF NOT EXISTS idx_api_keys_device_id ON api_keys (device_id)');
}

async function runMigrationsAndSeed(driver: SqlDriver, config: AppConfig): Promise<void> {
  if (driver.dialect === 'mysql') {
    for (const sql of MYSQL_DDL_STATEMENTS) {
      await driver.run(sql);
    }
  } else {
    // Defer idx_api_keys_device_id until ensureApiKeyDeviceColumns adds device_id on legacy DBs.
    const initialStatements = SQLITE_DDL_STATEMENTS.filter(
      (sql) => !sql.includes('idx_api_keys_device_id'),
    );
    await driver.batch(initialStatements.map((sql) => ({ sql })));
  }

  await ensureApiKeyDeviceColumns(driver);

  // Backfill device_groups join table idempotently from legacy devices.group_id
  if (driver.dialect === 'mysql') {
    await driver.run(
      "INSERT IGNORE INTO device_groups (device_id, group_id, created_at) SELECT id, group_id, created_at FROM devices WHERE group_id IS NOT NULL AND group_id != ''",
    );
  } else {
    await driver.run(
      "INSERT OR IGNORE INTO device_groups (device_id, group_id, created_at) SELECT id, group_id, created_at FROM devices WHERE group_id IS NOT NULL AND group_id != ''",
    );
  }

  const adminUsername = config.adminUsername || 'admin';
  // Seed default admin only when zero admins exist so deleting the initial admin does not resurrect it on restart.
  const existing = await driver.get<{ id: number }>(
    'SELECT id FROM users WHERE role = 1 LIMIT 1',
  );
  if (!existing) {
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(config.adminPassword || 'admin');
    const insertSql =
      driver.dialect === 'mysql'
        ? 'INSERT IGNORE INTO users (username, password_hash, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        : 'INSERT OR IGNORE INTO users (username, password_hash, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)';
    await driver.run(insertSql, [
      adminUsername,
      passwordHash,
      'admin@cslite.local',
      1,
      now,
      now,
    ]);
  }
}

/**
 * Ensures schema DDL and default admin user are initialized once per SqlDriver instance.
 */
export function ensureMigrated(driver: SqlDriver, config: AppConfig): Promise<void> {
  const existing = migratedDrivers.get(driver);
  if (existing) {
    return existing;
  }
  const pending = runMigrationsAndSeed(driver, config).catch((err) => {
    migratedDrivers.delete(driver);
    throw err;
  });
  migratedDrivers.set(driver, pending);
  return pending;
}
