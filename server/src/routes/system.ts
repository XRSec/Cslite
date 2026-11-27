import { Hono } from 'hono';
import type { SystemInfoDTO } from '../../../shared/types';
import { ok } from '../lib/response';
import type { AppEnv } from '../middleware/auth';

export function createSystemRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/info', (c) => {
    const config = c.get('config');
    const driver = c.get('driver');
    const dto: SystemInfoDTO = {
      version: config.version,
      runtime: config.runtime,
      db_dialect: driver.dialect,
      allow_registration: config.allowRegistration,
      heartbeat_interval: config.heartbeatInterval,
      poll_interval: config.pollInterval,
      server_time: new Date().toISOString(),
    };
    return ok(c, dto);
  });

  return router;
}
