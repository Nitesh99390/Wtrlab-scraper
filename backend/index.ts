import { config } from './config';
import { log, errMsg } from './logger';
import crypto from 'crypto';
import http from 'http';
import express, { NextFunction, Request, Response } from 'express';
import { clearTrackedIntervals, flushAllPersisted, sleep } from './util';
import * as tg from './telegram';
import { createWtrlabCore } from './generated/wtrlab_core';
import { BOT_COMMANDS, handleUpdate, initBot } from './bot';
import { drainJobs, jobStats } from './jobs';

// ---------------------------------------------------------------------------------------------
// Global safety net: a stray network error / rejected promise must never take the bot down.
// ---------------------------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => log.error('[unhandledRejection]', reason instanceof Error ? reason : String(reason)));
process.on('uncaughtException', (err) => log.error('[uncaughtException]', err));

if (!config.botToken) {
  log.error('BOT_TOKEN is not set. Copy .env.example to .env and set BOT_TOKEN (from @BotFather), or set it in your host dashboard.');
  process.exit(1);
}

const startedAt = Date.now();
let botUsername = '';
let transport: 'polling' | 'webhook' | 'starting' = 'starting';
let shuttingDown = false;
const pollAbort = new AbortController();
let pollLoop: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------------------------
// Express: /health, scraper API routes (wtrlab_catalog_and_routes.ts) and the optional webhook
// ---------------------------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get(['/health', '/healthz'], (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    bot: botUsername ? `@${botUsername}` : null,
    transport,
    jobs: jobStats(),
    catalogSize: core.catalogSize(),
    shuttingDown,
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.type('text/plain').send('WTR-Lab Telegram bot is running. See /health');
});

app.use(express.json({ limit: '2mb' }));

// Optional shared-secret guard for every /api route (recommended in production).
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!config.apiAuthToken) return next();
  const header = String(req.headers['authorization'] || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : String(req.headers['x-api-key'] || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(config.apiAuthToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

const core = createWtrlabCore(app);
initBot(core);

const webhookSecret = crypto.createHash('sha256').update(`wtrlab:${config.botToken}`).digest('hex').slice(0, 40);
const webhookPath = `/telegram/webhook/${webhookSecret}`;

app.post(webhookPath, (req: Request, res: Response) => {
  if (req.get('x-telegram-bot-api-secret-token') !== webhookSecret) return void res.sendStatus(401);
  res.sendStatus(200); // ack immediately - Telegram retries on slow responses
  void handleUpdate(req.body).catch((e) => log.error('[webhook] handler error', errMsg(e)));
});

// Anything that throws inside a route returns 500 instead of crashing.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.error('[express]', err instanceof Error ? err : String(err));
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

const server: http.Server = app.listen(config.port, '0.0.0.0', () => {
  log.info(`HTTP server listening on 0.0.0.0:${config.port} (health: /health)`);
  if (!config.apiAuthToken) log.warn('API_AUTH_TOKEN is not set - /api/* routes are publicly accessible. Set it in production.');
});
server.on('error', (e) => {
  log.error('[http] server error:', errMsg(e));
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') process.exit(1);
});
server.keepAliveTimeout = 65_000;

// ---------------------------------------------------------------------------------------------
// Telegram transport
// ---------------------------------------------------------------------------------------------
async function connectTelegram(): Promise<void> {
  for (let attempt = 0; !shuttingDown; attempt++) {
    try {
      const me = await tg.getMe();
      botUsername = me.username;
      log.info(`Authenticated as @${me.username} (id ${me.id})`);
      break;
    } catch (e) {
      if (e instanceof tg.TelegramError && (e.code === 401 || e.code === 404)) {
        log.error('BOT_TOKEN was rejected by Telegram (401/404). Check the token from @BotFather.');
        process.exit(1);
      }
      const wait = Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));
      log.warn(`getMe failed (${errMsg(e)}) - retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  if (shuttingDown) return;

  await tg.setMyCommands(BOT_COMMANDS).catch((e) => log.warn('setMyCommands failed:', errMsg(e)));

  if (config.useWebhook && config.publicUrl) {
    for (let attempt = 0; !shuttingDown; attempt++) {
      try {
        await tg.setWebhook(`${config.publicUrl}${webhookPath}`, webhookSecret);
        transport = 'webhook';
        log.info(`Webhook registered at ${config.publicUrl}/telegram/webhook/<secret>`);
        return;
      } catch (e) {
        log.warn(`setWebhook failed (${errMsg(e)}) - retrying`);
        await sleep(Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4)));
      }
    }
    return;
  }
  if (config.useWebhook) log.warn('USE_WEBHOOK=true but PUBLIC_URL / RENDER_EXTERNAL_URL is missing - falling back to long polling.');

  // Long polling needs the webhook removed.
  await tg.deleteWebhook().catch((e) => log.warn('deleteWebhook failed:', errMsg(e)));
  transport = 'polling';
  pollLoop = poll();
}

async function poll(): Promise<void> {
  let offset = 0;
  let failures = 0;
  log.info('Long polling started');
  while (!shuttingDown) {
    try {
      const updates = await tg.getUpdates(offset, 30, pollAbort.signal);
      failures = 0;
      for (const u of updates) {
        offset = Math.max(offset, Number(u.update_id) + 1);
        void handleUpdate(u).catch((e) => log.error('[poll] handler error', errMsg(e)));
      }
    } catch (e) {
      if (shuttingDown) break;
      failures++;
      let wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      if (e instanceof tg.TelegramError) {
        if (e.code === 409) {
          wait = 15_000;
          log.error('Telegram 409 conflict: another instance is polling with this BOT_TOKEN (or a webhook is set). Waiting...');
        } else if (e.code === 429 && e.retryAfter) {
          wait = e.retryAfter * 1000 + 500;
        } else if (e.code === 401) {
          log.error('BOT_TOKEN revoked/invalid (401). Exiting.');
          process.exit(1);
        }
      }
      if (failures === 1 || failures % 10 === 0) log.warn(`getUpdates failed (${errMsg(e)}) - retry in ${Math.round(wait / 1000)}s [#${failures}]`);
      await sleep(wait);
    }
  }
  log.info('Long polling stopped');
}

// Render free web services are put to sleep after ~15 min without INBOUND http traffic, which would kill a long
// download mid-way. While jobs are active we ping our own public URL so the instance stays awake.
if (config.publicUrl) {
  const keepAlive = setInterval(() => {
    const j = jobStats();
    if (shuttingDown || j.running + j.queued === 0) return;
    fetch(`${config.publicUrl}/health`, { signal: AbortSignal.timeout(10_000) }).catch((e) => log.debug('[keepalive] ping failed:', errMsg(e)));
  }, 4 * 60 * 1000);
  keepAlive.unref();
}

void connectTelegram().catch((e) => log.error('connectTelegram crashed:', errMsg(e)));

// ---------------------------------------------------------------------------------------------
// Graceful shutdown (Render sends SIGTERM on every deploy/restart; systemd/docker too)
// ---------------------------------------------------------------------------------------------
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received - shutting down gracefully (grace ${config.shutdownGraceMs}ms)`);
  const hardKill = setTimeout(() => {
    log.error('Graceful shutdown timed out - forcing exit');
    process.exit(1);
  }, config.shutdownGraceMs + 10_000);
  hardKill.unref();

  try {
    pollAbort.abort(); // stop taking new updates
    clearTrackedIntervals(); // stop crawler / schedulers
    server.close(); // stop accepting new HTTP connections
    server.closeIdleConnections?.();
    await drainJobs(config.shutdownGraceMs);
    await Promise.race([pollLoop, sleep(3000)]);
    flushAllPersisted();
    server.closeAllConnections?.();
  } catch (e) {
    log.error('Error during shutdown:', errMsg(e));
  } finally {
    log.info('Bye.');
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
