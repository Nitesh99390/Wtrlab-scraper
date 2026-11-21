import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function str(name: string, fallback = ''): string {
  return String(process.env[name] ?? fallback).trim();
}
function int(name: string, fallback: number, min = 0): number {
  const n = Number.parseInt(str(name), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = str(name).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}
function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name).toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

const publicUrl = (str('PUBLIC_URL') || str('RENDER_EXTERNAL_URL')).replace(/\/+$/, '');

export const config = {
  botToken: str('BOT_TOKEN'),
  port: int('PORT', 3000, 1),
  dataDir: path.resolve(str('DATA_DIR') || path.join(process.cwd(), '.runtime')),

  // Telegram transport: long polling (default) or webhook
  useWebhook: bool('USE_WEBHOOK', false),
  publicUrl,

  // Optional access control
  allowedChatIds: new Set(
    str('ALLOWED_CHAT_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ),
  apiAuthToken: str('API_AUTH_TOKEN'),

  // Optional upstream / translation keys
  jinaApiKey: str('JINA_API_KEY'),
  geminiApiKey: str('GEMINI_API_KEY'),
  geminiModel: str('GEMINI_MODEL', 'gemini-2.0-flash'),

  // Job limits
  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 2, 1),
  maxJobsPerChat: int('MAX_JOBS_PER_CHAT', 1, 1),
  shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 20000, 0),

  // Per-chat defaults
  defaultLanguage: oneOf('DEFAULT_LANGUAGE', ['en', 'hi'] as const, 'en'),
  defaultServiceMode: oneOf('DEFAULT_SERVICE_MODE', ['web', 'webplus', 'ai'] as const, 'ai'),
  defaultFormat: oneOf('DEFAULT_FORMAT', ['epub', 'txt'] as const, 'epub'),

  debug: bool('DEBUG', false),
};

export type Config = typeof config;
