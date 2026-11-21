export type ScrapeJob = {
  id: string;
  novelId: string;
  novelUrl: string;
  title: string;
  author: string;
  synopsis?: string;
  coverUrl?: string;
  startChapter: number;
  totalChapters: number;
  currentChapter?: number;
  chapterTitle?: string;
  progress: number;
  status: string;
  format: 'epub' | 'txt';
  language?: 'en' | 'hi';
  serviceMode?: string;
  filename?: string;
  fileBuffer?: Buffer;
  fileSize?: number;
  chapters?: any[];
  error?: string;
  completedAt?: string;
  chatId?: string;
  botToken?: string;
  telegramMessageId?: number;
  buildStats?: any;
  logs?: string[];
  createdAt?: number;
};

export type JobBuildVerificationSummary = {
  total: number;
  exact: number;
  near: number;
  repaired: number;
  mismatch: number;
  missing: number;
  duplicate: number;
  unavailable: number;
};

export type ServiceMode = 'web' | 'webplus' | 'ai';
export type Lang = 'en' | 'hi';
export type Format = 'epub' | 'txt';

export type ChapterLike = {
  num: number;
  title: string;
  paragraphs: string[];
  url?: string;
};
