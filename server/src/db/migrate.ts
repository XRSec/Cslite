import type { AppConfig } from '../config';
import { hashPassword } from '../lib/crypto';
import type { SqlDriver } from './driver';
import { MYSQL_DDL_STATEMENTS, SQLITE_DDL_STATEMENTS } from './schema';

const migratedDrivers = new WeakMap<SqlDriver, Promise<void>>();

async function runMigrationsAndSeed(driver: SqlDriver, config: AppConfig): Promise<void> {
  if (driver.dialect === 'mysql') {
    for (const sql of MYSQL_DDL_STATEMENTS) {
      await driver.run(sql);
    }
  } else {
    await driver.batch(SQLITE_DDL_STATEMENTS.map((sql) => ({ sql })));
  }

  const adminUsername = config.adminUsername || 'admin';
  const existing = await driver.get<{ id: number }>(
    'SELECT id FROM users WHERE username = ? LIMIT 1',
    [adminUsername],
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
