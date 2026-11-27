import { Hono } from 'hono';
import {
  ErrorCode,
  UserRole,
  type ApiKeyDTO,
  type CreateApiKeyRequest,
  type CreateUserRequest,
  type LoginRequest,
  type ChangePasswordRequest,
  type UserDTO,
} from '../../../shared/types';
import {
  generateApiKey,
  generateId,
  generateSessionToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from '../lib/crypto';
import { writeAuditLog } from '../lib/reconcile';
import {
  escapeLike,
  fail,
  getClientIp,
  ok,
  parsePagination,
  readJsonBody,
} from '../lib/response';
import {
  buildSessionCookieHeader,
  isCookieSecure,
  requireAdmin,
  requireAuth,
  type AppEnv,
  type AuthUser,
} from '../middleware/auth';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  email: string;
  role: number;
  created_at: string;
  updated_at: string;
}

function toUserDTO(row: Pick<UserRow | AuthUser, 'id' | 'username' | 'email' | 'role' | 'created_at' | 'updated_at'>): UserDTO {
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    role: (Number(row.role) === UserRole.ADMIN ? UserRole.ADMIN : UserRole.USER) as UserRole,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createAuthRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/login', async (c) => {
    const body = await readJsonBody<Partial<LoginRequest>>(c, c.get('config').maxPayloadBytes);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Username and password are required', 400);
    }

    const driver = c.get('driver');
    const config = c.get('config');
    const userRow = await driver.get<UserRow>(
      'SELECT id, username, password_hash, email, role, created_at, updated_at FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    if (!userRow) {
      return fail(c, ErrorCode.INVALID_CREDENTIALS, 'Invalid username or password', 401);
    }

    const valid = await verifyPassword(password, userRow.password_hash);
    if (!valid) {
      return fail(c, ErrorCode.INVALID_CREDENTIALS, 'Invalid username or password', 401);
    }

    const token = generateSessionToken();
    const tokenHash = await sha256Hex(token);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + config.sessionTtlSeconds * 1000).toISOString();

    await driver.run(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      [generateId('sess'), Number(userRow.id), tokenHash, expiresAt, nowIso],
    );

    const secure = isCookieSecure(c, config);
    c.header('Set-Cookie', buildSessionCookieHeader(token, config.sessionTtlSeconds, secure));

    await writeAuditLog(driver, {
      userId: Number(userRow.id),
      username: userRow.username,
      action: 'login',
      targetId: String(userRow.id),
      ip: getClientIp(c),
      timestamp: nowIso,
    });

    return ok(
      c,
      {
        user: toUserDTO(userRow),
        session_token: token,
      },
      'Login successful',
    );
  });

  router.post('/logout', requireAuth, async (c) => {
    const driver = c.get('driver');
    const config = c.get('config');
    const tokenHash = c.get('sessionTokenHash');
    const user = c.get('user');

    if (tokenHash) {
      await driver.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    }

    const secure = isCookieSecure(c, config);
    c.header('Set-Cookie', buildSessionCookieHeader('', 0, secure));

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'logout',
      targetId: String(user.id),
      ip: getClientIp(c),
    });

    return ok(c, null, 'Logged out');
  });

  router.get('/me', requireAuth, async (c) => {
    return ok(c, toUserDTO(c.get('user')));
  });

  router.post('/password', requireAuth, async (c) => {
    const body = await readJsonBody<Partial<ChangePasswordRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';

    if (!oldPassword || newPassword.length < 6 || newPassword.length > 128) {
      return fail(
        c,
        ErrorCode.VALIDATION_ERROR,
        'old_password is required and new_password must be 6-128 characters',
        400,
      );
    }

    const driver = c.get('driver');
    const user = c.get('user');
    const row = await driver.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
      [user.id],
    );
    if (!row) {
      return fail(c, ErrorCode.NOT_FOUND, 'User not found', 404);
    }

    const valid = await verifyPassword(oldPassword, row.password_hash);
    if (!valid) {
      return fail(c, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect', 401);
    }

    const newHash = await hashPassword(newPassword);
    const nowIso = new Date().toISOString();
    const currentHash = c.get('sessionTokenHash');

    const stmts = [
      {
        sql: 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
        params: [newHash, nowIso, user.id],
      },
      currentHash
        ? {
            sql: 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?',
            params: [user.id, currentHash],
          }
        : {
            sql: 'DELETE FROM sessions WHERE user_id = ?',
            params: [user.id],
          },
    ];
    await driver.batch(stmts);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'change_password',
      targetId: String(user.id),
      ip: getClientIp(c),
      timestamp: nowIso,
    });

    return ok(c, null, 'Password updated');
  });

  router.get('/key', requireAuth, async (c) => {
    const driver = c.get('driver');
    const user = c.get('user');
    const isAdmin = user.role === UserRole.ADMIN;
    const rows = await driver.all<{
      id: string;
      name: string;
      key_prefix: string;
      user_id: number;
      owner_username: string | null;
      device_id: string | null;
      device_name: string | null;
      created_at: string;
      last_used: string | null;
    }>(
      isAdmin
        ? 'SELECT ak.id, ak.name, ak.key_prefix, ak.user_id, u.username AS owner_username, ak.device_id, d.name AS device_name, ak.created_at, ak.last_used FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id LEFT JOIN devices d ON d.id = ak.device_id ORDER BY ak.created_at DESC'
        : 'SELECT ak.id, ak.name, ak.key_prefix, ak.user_id, u.username AS owner_username, ak.device_id, d.name AS device_name, ak.created_at, ak.last_used FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id LEFT JOIN devices d ON d.id = ak.device_id WHERE ak.user_id = ? ORDER BY ak.created_at DESC',
      isAdmin ? [] : [user.id],
    );
    const keys: ApiKeyDTO[] = rows.map((k) => ({
      id: k.id,
      name: k.name,
      key_prefix: k.key_prefix,
      user_id: Number(k.user_id),
      owner_username: k.owner_username ?? undefined,
      device_id: k.device_id ?? null,
      device_name: k.device_name ?? undefined,
      created_at: k.created_at,
      last_used: k.last_used ?? null,
    }));
    return ok(c, { total: keys.length, keys });
  });

  router.post('/key', requireAuth, async (c) => {
    const body = await readJsonBody<Partial<CreateApiKeyRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    const name = rawName ? rawName.slice(0, 100) : 'default';

    const driver = c.get('driver');
    const user = c.get('user');
    const id = generateId('key');
    const rawKey = generateApiKey();
    const keyHash = await sha256Hex(rawKey);
    const keyPrefix = `${rawKey.slice(0, 12)}...`;
    const nowIso = new Date().toISOString();

    await driver.run(
      'INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, device_id, key_secret, last_used, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)',
      [id, user.id, name, keyHash, keyPrefix, nowIso],
    );

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'create_api_key',
      targetId: id,
      ip: getClientIp(c),
      timestamp: nowIso,
    });

    return ok(
      c,
      {
        id,
        name,
        api_key: rawKey,
        key_prefix: keyPrefix,
        created_at: nowIso,
      },
      'API key created',
      201,
    );
  });

  router.delete('/key/:id', requireAuth, async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    const row = await driver.get<{ id: string; user_id: number }>(
      'SELECT id, user_id FROM api_keys WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) {
      return fail(c, ErrorCode.NOT_FOUND, 'API key not found', 404);
    }
    if (Number(row.user_id) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    await driver.run('DELETE FROM api_keys WHERE id = ?', [id]);

    const nowIso = new Date().toISOString();
    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'delete_api_key',
      targetId: id,
      ip: getClientIp(c),
      timestamp: nowIso,
    });

    return ok(c, { id, deleted_at: nowIso }, 'API key deleted');
  });

  router.get('/user', requireAuth, requireAdmin, async (c) => {
    const driver = c.get('driver');
    const { page, limit, offset } = parsePagination(c);
    const roleFilter = c.req.query('role');
    const search = c.req.query('search')?.trim() || '';

    const where: string[] = [];
    const params: Array<string | number | null> = [];

    if (roleFilter === '0' || roleFilter === '1') {
      where.push('role = ?');
      params.push(Number.parseInt(roleFilter, 10));
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      where.push("(username LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!')");
      params.push(like, like);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM users ${whereSql}`,
      params,
    );
    const rows = await driver.all<UserRow>(
      `SELECT id, username, email, role, created_at, updated_at FROM users ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return ok(c, {
      total: Number(countRow?.total ?? 0),
      page,
      per_page: limit,
      users: rows.map(toUserDTO),
    });
  });

  router.post('/user', requireAuth, requireAdmin, async (c) => {
    const body = await readJsonBody<Partial<CreateUserRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 255) : '';
    const role = body.role === UserRole.ADMIN ? UserRole.ADMIN : UserRole.USER;

    if (
      username.length < 3 ||
      username.length > 50 ||
      !/^[a-zA-Z0-9_.-]+$/.test(username) ||
      password.length < 6 ||
      password.length > 128
    ) {
      return fail(
        c,
        ErrorCode.VALIDATION_ERROR,
        'Invalid username (3-50 alphanumeric/._-) or password (6-128 chars)',
        400,
      );
    }

    const driver = c.get('driver');
    const existing = await driver.get<{ id: number }>(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    if (existing) {
      return fail(c, ErrorCode.USER_EXISTS, 'Username already exists', 409);
    }

    const passwordHash = await hashPassword(password);
    const nowIso = new Date().toISOString();
    const res = await driver.run(
      'INSERT INTO users (username, password_hash, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [username, passwordHash, email, role, nowIso, nowIso],
    );

    const created = await driver.get<UserRow>(
      res.lastInsertRowid
        ? 'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = ? LIMIT 1'
        : 'SELECT id, username, email, role, created_at, updated_at FROM users WHERE username = ? LIMIT 1',
      [res.lastInsertRowid ?? username],
    );

    if (!created) {
      return fail(c, ErrorCode.INTERNAL_ERROR, 'Failed to read created user', 500);
    }

    const actor = c.get('user');
    await writeAuditLog(driver, {
      userId: actor.id,
      username: actor.username,
      action: 'create_user',
      targetId: String(created.id),
      ip: getClientIp(c),
      detail: created.username,
      timestamp: nowIso,
    });

    return ok(c, toUserDTO(created), 'User created', 201);
  });

  router.delete('/user/:id', requireAuth, requireAdmin, async (c) => {
    const rawId = c.req.param('id');
    if (!/^\d+$/.test(rawId)) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid user id', 400);
    }
    const targetId = Number.parseInt(rawId, 10);
    const actor = c.get('user');

    const driver = c.get('driver');
    const existing = await driver.get<{ id: number; username: string; role: number }>(
      'SELECT id, username, role FROM users WHERE id = ? LIMIT 1',
      [targetId],
    );
    if (!existing) {
      return fail(c, ErrorCode.NOT_FOUND, 'User not found', 404);
    }

    const isAdminTarget = Number(existing.role) === UserRole.ADMIN;
    if (isAdminTarget) {
      const adminCountRow = await driver.get<{ total: number }>(
        'SELECT COUNT(*) AS total FROM users WHERE role = 1',
      );
      if (Number(adminCountRow?.total ?? 0) <= 1) {
        return fail(c, ErrorCode.CONFLICT, 'Cannot delete the last admin', 409);
      }
    }
    if (targetId === actor.id) {
      return fail(c, ErrorCode.CONFLICT, 'Cannot delete yourself', 409);
    }

    // Preserve admin probe API keys by transferring to the acting admin; revoke non-admin personal keys.
    await driver.batch([
      isAdminTarget
        ? { sql: 'UPDATE api_keys SET user_id = ? WHERE user_id = ?', params: [actor.id, targetId] }
        : { sql: 'DELETE FROM api_keys WHERE user_id = ?', params: [targetId] },
      { sql: 'UPDATE devices SET owner_id = ? WHERE owner_id = ?', params: [actor.id, targetId] },
      { sql: 'UPDATE agents SET owner_id = ? WHERE owner_id = ?', params: [actor.id, targetId] },
      { sql: 'UPDATE `groups` SET created_by = ? WHERE created_by = ?', params: [actor.id, targetId] },
      { sql: 'UPDATE commands SET created_by = ? WHERE created_by = ?', params: [actor.id, targetId] },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', params: [targetId] },
      { sql: 'DELETE FROM users WHERE id = ?', params: [targetId] },
    ]);

    const nowIso = new Date().toISOString();
    await writeAuditLog(driver, {
      userId: actor.id,
      username: actor.username,
      action: 'delete_user',
      targetId: String(targetId),
      ip: getClientIp(c),
      detail: existing.username,
      timestamp: nowIso,
    });

    return ok(c, { deleted_at: nowIso }, 'User deleted');
  });

  return router;
}
