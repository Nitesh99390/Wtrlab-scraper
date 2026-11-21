import path from 'path';
import { config } from './config';
import { Format, Lang, ServiceMode } from './types';
import { PersistedMap } from './util';

type Prefs = { language: Lang; mode: ServiceMode; format: Format };

const store = new PersistedMap<Partial<Prefs>>(path.join(config.dataDir, 'chat_prefs.json'), 20000);

export function getPrefs(chatId: string): Prefs {
  const p = store.get(chatId) || {};
  return {
    language: p.language || config.defaultLanguage,
    mode: p.mode || config.defaultServiceMode,
    format: p.format || config.defaultFormat,
  };
}

export function setPrefs(chatId: string, patch: Partial<Prefs>): void {
  store.set(chatId, { ...(store.get(chatId) || {}), ...patch });
}
