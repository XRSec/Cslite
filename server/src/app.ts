import { Hono, type Context } from 'hono';
import { ErrorCode } from '../../shared/types';
import { buildConfig, type AppConfig, type RuntimeKind } from './config';
import type { SqlDriver } from './db/driver';
import { ensureMigrated } from './db/migrate';
import { constantTimeEqual } from './lib/crypto';
import { fail, getRequestOrigin, HttpApiError, ok } from './lib/response';
import type { AppEnv } from './middleware/auth';
import { createAgentRoutes } from './routes/agent';
import { createAuthRoutes } from './routes/auth';
import { createCommandRoutes } from './routes/commands';
import { createDeviceRoutes } from './routes/devices';
import { createGroupRoutes } from './routes/groups';
import { createLogRoutes } from './routes/logs';
import { createSystemRoutes } from './routes/system';
import {
  AGENT_LITE_PS1,
  AGENT_LITE_SH,
  INSTALL_ANDROID_SH,
  INSTALL_UNIX_SH,
  INSTALL_WINDOWS_PS1,
  OPENWRT_INIT_SH,
  UPGRADE_UNIX_SH,
  UPGRADE_WINDOWS_PS1,
} from './scripts-bundle';
import { UI_HTML } from './ui-bundle';

export { buildConfig, type AppConfig, type RuntimeKind };

/**
 * Creates the portable Web-Standards Hono application.
 * Zero Node-only or MySQL imports are permitted here so Cloudflare Workers bundle cleanly.
 */
export function createApp(driver: SqlDriver, config: AppConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('driver', driver);
    c.set('config', config);
    if (config.originSecret) {
      const supplied = c.req.header(config.originSecretHeader) ?? '';
      if (!supplied || !constantTimeEqual(supplied, config.originSecret)) {
        return new Response(null, {
          status: 403,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
    }
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // Zero-CPU, zero-DB health check
  app.get('/health', (c) => {
    return ok(c, {
      status: 'ok',
      runtime: config.runtime,
      timestamp: new Date().toISOString(),
    });
  });

  // Ensure schema & admin seed once per driver ONLY on /api/*
  app.use('/api/*', async (c, next) => {
    await ensureMigrated(driver, config);
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.route('/api/auth', createAuthRoutes());
  app.route('/api/devices', createDeviceRoutes());
  app.route('/api/groups', createGroupRoutes());
  app.route('/api/commands', createCommandRoutes());
  app.route('/api/agent', createAgentRoutes());
  app.route('/api/logs', createLogRoutes());
  app.route('/api/system', createSystemRoutes());

  app.all('/api/*', (c) => {
    return fail(c, ErrorCode.NOT_FOUND, 'API endpoint not found', 404);
  });

  const serveUi = (c: Context<AppEnv>) =>
    c.html(UI_HTML, 200, { 'Cache-Control': 'public, max-age=300' });

  app.get('/', serveUi);
  app.get('/index.html', serveUi);

  const scriptRoutes: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ['/i', INSTALL_UNIX_SH, 'text/x-shellscript; charset=utf-8', true],
    ['/install.sh', INSTALL_UNIX_SH, 'text/x-shellscript; charset=utf-8', true],
    ['/u', UPGRADE_UNIX_SH, 'text/x-shellscript; charset=utf-8', true],
    ['/upgrade.sh', UPGRADE_UNIX_SH, 'text/x-shellscript; charset=utf-8', true],
    ['/i.ps1', INSTALL_WINDOWS_PS1, 'text/plain; charset=utf-8', true],
    ['/install.ps1', INSTALL_WINDOWS_PS1, 'text/plain; charset=utf-8', true],
    ['/u.ps1', UPGRADE_WINDOWS_PS1, 'text/plain; charset=utf-8', true],
    ['/upgrade.ps1', UPGRADE_WINDOWS_PS1, 'text/plain; charset=utf-8', true],
    ['/ia', INSTALL_ANDROID_SH, 'text/x-shellscript; charset=utf-8', true],
    ['/install-android.sh', INSTALL_ANDROID_SH, 'text/x-shellscript; charset=utf-8', true],
    ['/agent-lite.sh', AGENT_LITE_SH, 'text/x-shellscript; charset=utf-8', false],
    ['/agent-lite.ps1', AGENT_LITE_PS1, 'text/plain; charset=utf-8', false],
    ['/openwrt/cslite-agent.init', OPENWRT_INIT_SH, 'text/x-shellscript; charset=utf-8', false],
  ];

  for (const [routePath, template, contentType, bakeOrigin] of scriptRoutes) {
    app.get(routePath, (c) => {
      const origin = bakeOrigin ? getRequestOrigin(c) : '';
      const body = bakeOrigin
        ? template.replaceAll('__CSLITE_DEFAULT_SERVER__', () => origin)
        : template;
      return c.text(body, 200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
    });
  }

  app.onError((err, c) => {
    if (err instanceof HttpApiError) {
      return fail(c, err.code, err.message, err.status);
    }
    console.error('[cslite] Unhandled request error:', err);
    return fail(c, ErrorCode.INTERNAL_ERROR, 'Internal server error', 500);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return fail(c, ErrorCode.NOT_FOUND, 'Not found', 404);
    }
    return c.html(UI_HTML, 200, { 'Cache-Control': 'public, max-age=300' });
  });

  return app;
}
