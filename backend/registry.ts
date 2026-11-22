import crypto from 'crypto';
import path from 'path';
import { config } from './config';
import { PersistedMap } from './util';

export type RegisteredNovel = {
  novelUrl: string;
  novelId: string;
  title: string;
  totalChapters: number;
  hasUnverifiedCount?: boolean;
  platform: string;
  coverUrl?: string;
};

const registry = new PersistedMap<RegisteredNovel & { at: number }>(
  path.join(config.dataDir, 'callback_registry.json'),
  3000
);

/** Short deterministic token (fits Telegram's 64-byte callback_data limit). */
export function registerNovelForCallback(info: RegisteredNovel): string {
  const token = crypto.createHash('sha1').update(`${info.platform}|${info.novelId}`).digest('base64url').slice(0, 8);
  registry.set(token, { ...info, at: Date.now() });
  return token;
}

export function getNovelByToken(token: string): RegisteredNovel | undefined {
  return registry.get(token);
}
