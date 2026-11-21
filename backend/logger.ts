import { config } from './config';

function redact(s: string): string {
  let out = s;
  if (config.botToken) out = out.split(config.botToken).join('<BOT_TOKEN>');
  return out.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<REDACTED>');
}

function fmt(args: unknown[]): string {
  return redact(
    args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : safeJson(a)))
      .join(' ')
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const ts = () => new Date().toISOString();

export const log = {
  info: (...a: unknown[]) => console.log(`${ts()} INFO  ${fmt(a)}`),
  warn: (...a: unknown[]) => console.warn(`${ts()} WARN  ${fmt(a)}`),
  error: (...a: unknown[]) => console.error(`${ts()} ERROR ${fmt(a)}`),
  debug: (...a: unknown[]) => {
    if (config.debug) console.log(`${ts()} DEBUG ${fmt(a)}`);
  },
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) return redact(e.message);
  return redact(String(e));
}
