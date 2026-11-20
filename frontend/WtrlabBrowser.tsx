import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  RefreshCw,
  Sparkles,
  BookOpen,
  Download,
  ExternalLink,
  CheckCircle2,
  X,
  Send,
  Loader2,
  AlertCircle,
  Clock,
  Layers,
  ArrowUp,
  ShieldCheck,
  Star,
  Zap,
  Globe,
  ChevronLeft,
  ChevronRight,
  Flame,
  Award,
  Sword,
  Library,
  ArrowUpDown,
  Hash,
  Compass,
  Terminal,
  FileCheck2,
} from 'lucide-react';

import { ChapterServiceMode } from '../types';
import { startLocalBuild, logLocalBuild, finishLocalBuild } from '../utils/buildTerminalBus';

export interface WtrlabNovelItem {
  id: string;
  rawId: string;
  slug: string;
  title: string;
  novelUrl: string;
  coverUrl: string;
  proxiedCoverUrl: string;
  author: string;
  genres: string[];
  chaptersCount: number;
  chaptersAdded?: number;
  rating: number;
  status: string;
  lastUpdated: string;
  description: string;
}

interface WtrlabBrowserProps {
  onSelectForCrawl?: (url: string) => void;
  onOpenBuildTerminal?: (buildId?: string) => void;
}

type WtrlabSortMode = 'newest' | 'oldest' | 'daily' | 'popular' | 'rating' | 'chapters';
export type NovelPlatform = 'wtrlab';

interface VerifyChapterSummary {
  verdict: 'exact_match' | 'near_match' | 'mismatch' | 'unavailable';
  similarityPct: number;
  titleMatched: boolean;
  liveSource: string;
  appSource?: string;
  liveTitle: string;
  appTitle: string;
  liveParasCount: number;
  appParasCount: number;
  liveWords: number;
  appWords: number;
  firstParaMatch: boolean;
  lastParaMatch: boolean;
  livePreview: string[];
  appPreview: string[];
  message: string;
}

interface ScrapeModalState {
  isOpen: boolean;
  novel: WtrlabNovelItem | null;
  mode: 'demo' | 'all' | 'custom';
  customStart: number;
  customEnd: number;
  format: 'epub' | 'txt';
  language: 'en' | 'hi';
  serviceMode: ChapterServiceMode;
  sendTelegram: boolean;
  isStarting: boolean;
  isRefreshingMeta?: boolean;
  activeJobId: string | null;
  modalError?: string | null;
  verifyChapterNo?: number;
  verifyingText?: boolean;
  verifyResult?: VerifyChapterSummary | null;
  verifyAll?: {
    verifyId: string;
    buildId: string;
    status: 'running' | 'completed' | 'cancelled' | 'failed';
    totalChapters: number;
    checkedCount: number;
    exactMatchCount: number;
    nearMatchCount: number;
    mismatchCount: number;
    unavailableCount: number;
    currentChapter: number;
    pct: number;
    results: Array<{
      chapterNo: number;
      verdict: 'exact_match' | 'near_match' | 'mismatch' | 'unavailable';
      similarityPct: number;
      titleMatched: boolean;
      liveParasCount: number;
      appParasCount: number;
      liveWords: number;
      appWords: number;
      appTitle: string;
      liveTitle: string;
      message: string;
    }>;
  } | null;
  jobProgress?: {
    currentCh: number;
    totalCh: number;
    pct: number;
    status: string;
    isDone: boolean;
    error?: string;
    verdict?: 'running' | 'clean' | 'warnings' | 'failed';
    errorCount?: number;
    placeholderCount?: number;
    telegramDelivered?: boolean;
    telegramBlocked?: boolean;
    telegramBlockedReason?: string;
    telegramError?: string;
  };
}

interface CrawlerStatusInfo {
  running: boolean;
  paused: boolean;
  pagesCrawled: number;
  totalQueuePages: number;
  remoteTotalCount?: number;
  realNovelsCount: number;
  realCoversCount: number;
  currentTarget: string;
}

interface WtrlabScheduleInfo {
  scheduledTimeFormatted: string;
  timezone: string;
  nextRefreshIso: string;
  nextRefreshTimestamp: number;
  countdownSeconds: number;
  lastRefreshedAt: number;
  lastRefreshedIso: string;
  lastSyncSummary?: {
    harvestedCount: number;
    updatedCount: number;
    newCount: number;
    reason: string;
  };
  syncInProgress?: boolean;
}

function buildFallbackCoverUrl(novel: Pick<WtrlabNovelItem, 'id' | 'rawId' | 'title' | 'author' | 'proxiedCoverUrl'>) {
  return (
    novel.proxiedCoverUrl ||
    `/api/wtrlab/cover?title=${encodeURIComponent(novel.title)}&author=${encodeURIComponent(novel.author || '')}&id=${encodeURIComponent(novel.rawId || novel.id)}`
  );
}

/**
 * Shared Reusable Novel Card — eliminates 200+ lines of duplicate card JSX between Rails and Grid!
 */
function NovelCard({
  novel,
  compact = false,
  onOpenModal,
  onSelectForCrawl,
}: {
  novel: WtrlabNovelItem;
  compact?: boolean;
  onOpenModal: (novel: WtrlabNovelItem, mode: 'demo' | 'all' | 'custom') => void;
  onSelectForCrawl?: (url: string) => void;
}) {
  const nid = String(novel.rawId || novel.id);
  const demoMax = Math.min(25, Math.max(1, novel.chaptersCount || 25));

  return (
    <div
      className={`${
        compact ? 'snap-start shrink-0 w-[260px] sm:w-[280px]' : 'group'
      } bg-slate-900/90 border border-slate-800/90 hover:border-sky-500/50 rounded-2xl overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-1 hover:shadow-xl hover:shadow-sky-950/20`}
    >
      <div className={`${compact ? 'p-3.5 gap-3' : 'p-4 gap-4'} flex flex-1`}>
        <div
          className={`relative ${
            compact ? 'w-20 h-28' : 'w-24 h-32'
          } shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-slate-900 via-sky-950/50 to-slate-950 border border-slate-800/80 shadow-md`}
        >
          <img
            key={`${novel.id}-${novel.coverUrl || 'svg'}`}
            src={buildFallbackCoverUrl(novel)}
            alt={novel.title}
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
            onError={(e) => {
              const img = e.currentTarget;
              if (img.dataset.fallbackFor === nid) return;
              img.dataset.fallbackFor = nid;
              img.src = `/api/wtrlab/cover?title=${encodeURIComponent(novel.title)}&author=${encodeURIComponent(novel.author || '')}&id=${encodeURIComponent(nid)}`;
            }}
          />
          <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-slate-950/90 text-[9px] font-mono font-bold text-sky-300 border border-sky-500/30 flex items-center gap-0.5 tabular-nums">
            <Hash className="w-2 h-2 text-sky-400" />
            <span>{nid}</span>
          </div>
          <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-slate-950/90 text-[9px] font-bold text-amber-300 border border-amber-500/30 flex items-center gap-0.5 tabular-nums">
            <Star className="w-2 h-2 fill-amber-400 text-amber-400" />
            <span>{(novel.rating || 4.8).toFixed(1)}</span>
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-between">
          <div>
            <h4
              className={`${
                compact ? 'text-xs' : 'text-sm'
              } font-bold text-white hover:text-sky-300 transition-colors line-clamp-2 leading-snug cursor-pointer`}
              title={novel.title}
              onClick={() => onOpenModal(novel, 'demo')}
            >
              {novel.title}
            </h4>
            <p className="text-[11px] text-slate-400 mt-1 truncate">
              By <span className="text-slate-300">{novel.author}</span>
            </p>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {(novel.genres || []).slice(0, compact ? 1 : 2).map((g) => (
                <span
                  key={g}
                  className="text-[10px] text-sky-300/90 bg-sky-950/50 border border-sky-800/40 rounded px-1.5 py-0.5"
                >
                  {g}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono tabular-nums mt-2">
            <span className="text-slate-300 font-semibold">{novel.chaptersCount.toLocaleString()} Chs</span>
            <span className="text-slate-600">·</span>
            <span className={novel.status === 'Completed' ? 'text-emerald-400' : 'text-sky-400'}>{novel.status}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-500 truncate">{novel.lastUpdated}</span>
          </div>
        </div>
      </div>

      {!compact && novel.description && (
        <div className="px-4 pb-2 text-[11px] text-slate-400 line-clamp-2 leading-relaxed">{novel.description}</div>
      )}

      <div className="mt-auto px-3.5 py-2.5 bg-slate-950/70 border-t border-slate-800/80 flex items-center gap-1.5">
        <button
          onClick={() => onOpenModal(novel, 'demo')}
          className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg bg-sky-500/10 hover:bg-sky-500 text-sky-300 hover:text-slate-950 text-[11px] font-bold border border-sky-500/30 hover:border-sky-500 transition-all cursor-pointer"
        >
          <Sparkles className="w-3 h-3" />
          <span>Demo (1-{demoMax})</span>
        </button>

        <button
          onClick={() => onOpenModal(novel, 'all')}
          className="inline-flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold border border-slate-700 transition-all cursor-pointer"
        >
          <Download className="w-3 h-3" />
          <span>All</span>
        </button>

        {!compact && (
          <button
            onClick={() => onOpenModal(novel, 'custom')}
            className="inline-flex items-center justify-center p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border border-slate-700/80 transition-all cursor-pointer"
            title="Select custom chapter range"
          >
            <Layers className="w-3.5 h-3.5" />
          </button>
        )}

        {onSelectForCrawl && (
          <button
            onClick={() => onSelectForCrawl(novel.novelUrl)}
            className="inline-flex items-center justify-center p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border border-slate-700/80 transition-all cursor-pointer"
            title="Open in URL Scraper Workspace"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function SectionScrollRail({
  title,
  subtitle,
  icon: Icon,
  novels,
  accentColor = 'sky',
  onOpenModal,
  onSelectForCrawl,
  headerAction,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  novels: WtrlabNovelItem[];
  accentColor?: 'sky' | 'amber' | 'emerald' | 'purple';
  onOpenModal: (novel: WtrlabNovelItem, mode: 'demo' | 'all' | 'custom') => void;
  onSelectForCrawl?: (url: string) => void;
  headerAction?: React.ReactNode;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const checkScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 10);
  }, []);

  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);
    return () => window.removeEventListener('resize', checkScroll);
  }, [novels, checkScroll]);

  const handleScroll = (direction: 'left' | 'right') => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.clientWidth * 0.75;
    el.scrollBy({ left: direction === 'left' ? -distance : distance, behavior: 'smooth' });
  };

  if (novels.length === 0) return null;

  const accentClasses =
    accentColor === 'amber'
      ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
      : accentColor === 'emerald'
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      : accentColor === 'purple'
      ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
      : 'bg-sky-500/10 text-sky-400 border-sky-500/20';

  return (
    <div className="space-y-3 relative">
      <div className="flex items-center justify-between px-1 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`p-2 rounded-xl border shadow-xs shrink-0 ${accentClasses}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-white tracking-tight truncate">{title}</h3>
            <p className="text-xs text-slate-400 truncate">{subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {headerAction}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleScroll('left')}
              disabled={!canScrollLeft}
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleScroll('right')}
              disabled={!canScrollRight}
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={checkScroll}
        className="flex gap-4 overflow-x-auto pb-3 pt-1 scroll-smooth snap-x snap-mandatory select-none"
        style={{ scrollbarWidth: 'thin' }}
      >
        {novels.map((novel) => (
          <NovelCard
            key={novel.id}
            novel={novel}
            compact
            onOpenModal={onOpenModal}
            onSelectForCrawl={onSelectForCrawl}
          />
        ))}
      </div>
    </div>
  );
}

export function WtrlabBrowser({ onSelectForCrawl, onOpenBuildTerminal }: WtrlabBrowserProps) {
  const [railsData, setRailsData] = useState<{
    daily: WtrlabNovelItem[];
    trending: WtrlabNovelItem[];
    topRated: WtrlabNovelItem[];
    cultivation: WtrlabNovelItem[];
  }>({ daily: [], trending: [], topRated: [], cultivation: [] });

  const [directoryNovels, setDirectoryNovels] = useState<WtrlabNovelItem[]>([]);
  const directoryNovelsRef = useRef<WtrlabNovelItem[]>([]);
  useEffect(() => {
    directoryNovelsRef.current = directoryNovels;
  }, [directoryNovels]);

  const [page, setPage] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [totalAvailable, setTotalAvailable] = useState<number>(0);
  const [remoteTotalCount, setRemoteTotalCount] = useState<number>(117465);
  const [selectedGenre, setSelectedGenre] = useState<string>('All');
  const [selectedStatus, setSelectedStatus] = useState<string>('All');
  const [searchInput, setSearchInput] = useState<string>('');
  const [sort, setSort] = useState<WtrlabSortMode>('daily');
  const [selectedEra, setSelectedEra] = useState<string>('all');
  const [jumpIdInput, setJumpIdInput] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isFetchingMore, setIsFetchingMore] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [customUrlInput, setCustomUrlInput] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState<boolean>(false);
  const [activeSection, setActiveSection] = useState<string>('section-daily');

  const [crawlerStats, setCrawlerStats] = useState<CrawlerStatusInfo | null>(null);
  const [isControllingCrawler, setIsControllingCrawler] = useState<boolean>(false);
  const [schedule, setSchedule] = useState<WtrlabScheduleInfo | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const [isSyncingSchedule, setIsSyncingSchedule] = useState<boolean>(false);

  const [modal, setModal] = useState<ScrapeModalState>({
    isOpen: false,
    novel: null,
    mode: 'demo',
    customStart: 1,
    customEnd: 25,
    format: 'epub',
    language: 'en',
    serviceMode: 'ai',
    sendTelegram: true,
    isStarting: false,
    isRefreshingMeta: false,
    activeJobId: null,
    modalError: null,
  });

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const activeJobTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSeenSyncAtRef = useRef<number>(0);

  const fetchRails = useCallback(async (forceRefresh = false) => {
    try {
      const res = await fetch(forceRefresh ? '/api/wtrlab/rails?refresh=1' : '/api/wtrlab/rails');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.rails) {
        setRailsData({
          daily: data.rails.daily || [],
          trending: data.rails.trending || [],
          topRated: data.rails.topRated || [],
          cultivation: data.rails.cultivation || [],
        });
      }
      if (data.crawler) setCrawlerStats(data.crawler);
    } catch {}
  }, []);

  const fetchCrawlerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/wtrlab/crawler/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) setCrawlerStats(data);
    } catch {}
  }, []);

  const fetchDirectoryPage = useCallback(
    async (
      targetPage: number,
      targetSort: WtrlabSortMode,
      search: string,
      genre: string,
      status: string,
      era: string,
      isReset = false
    ) => {
      try {
        if (isReset) setIsLoading(true);
        else setIsFetchingMore(true);
        setErrorMessage(null);

        const params = new URLSearchParams({
          page: targetPage.toString(),
          pageSize: '24',
          sort: targetSort,
        });
        if (search) params.set('search', search);
        if (genre && genre !== 'All') params.set('genre', genre);
        if (status && status !== 'All') params.set('status', status);
        if (era && era !== 'all') params.set('era', era);
        if (!isReset && targetPage > 0 && directoryNovelsRef.current.length > 0) {
          params.set('excludeIds', directoryNovelsRef.current.slice(-240).map((n) => n.id).join(','));
        }

        const res = await fetch(`/api/wtrlab/feed?${params.toString()}`);
        if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

        const data = await res.json();
        if (data.crawler) setCrawlerStats(data.crawler);
        if (typeof data.remoteTotalCount === 'number' && data.remoteTotalCount > 0) {
          setRemoteTotalCount(data.remoteTotalCount);
        }

        if (data.success && Array.isArray(data.novels)) {
          if (isReset) {
            setDirectoryNovels(data.novels);
          } else {
            setDirectoryNovels((prev) => {
              const existingIds = new Set(prev.map((n) => String(n.id)));
              return [...prev, ...data.novels.filter((n: WtrlabNovelItem) => !existingIds.has(String(n.id)))];
            });
          }
          setHasMore(data.hasMore === true);
          setTotalAvailable(data.realNovelsCount || data.totalAvailable || data.novels.length);
        } else {
          if (isReset) setDirectoryNovels([]);
          setHasMore(false);
        }
      } catch (err: any) {
        setErrorMessage(err.message || 'Failed to connect to WTR-Lab catalog feed');
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    []
  );

  const handleCrawlerControl = async (action: 'pause' | 'resume' | 'boost') => {
    try {
      setIsControllingCrawler(true);
      const res = await fetch('/api/wtrlab/crawler/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.success) {
        setCrawlerStats(data);
        if (action === 'boost') {
          fetchRails();
          fetchDirectoryPage(0, sort, searchQuery, selectedGenre, selectedStatus, selectedEra, true);
        }
      }
    } catch {} finally {
      setIsControllingCrawler(false);
    }
  };

  useEffect(() => {
    fetchRails();
    const timer = setInterval(fetchCrawlerStatus, 8000);
    return () => clearInterval(timer);
  }, [fetchRails, fetchCrawlerStatus]);

  useEffect(() => {
    const fetchSchedule = async () => {
      try {
        const res = await fetch('/api/wtrlab/schedule');
        if (!res.ok) return;
        const data = await res.json();
        if (data.success) {
          setSchedule(data);
          setCountdown(data.countdownSeconds || 0);
          const remoteSyncAt = Number(data.lastRefreshedAt || 0);
          if (remoteSyncAt > 0 && lastSeenSyncAtRef.current > 0 && remoteSyncAt > lastSeenSyncAtRef.current) {
            fetchRails(false);
            fetchDirectoryPage(0, sort, searchQuery, selectedGenre, selectedStatus, selectedEra, true);
          }
          if (remoteSyncAt > 0) lastSeenSyncAtRef.current = remoteSyncAt;
        }
      } catch {}
    };
    fetchSchedule();
    const sw = setInterval(fetchSchedule, 15000);
    const ticker = setInterval(() => setCountdown((p) => (p <= 1 ? 0 : p - 1)), 1000);
    return () => {
      clearInterval(sw);
      clearInterval(ticker);
    };
  }, [sort, searchQuery, selectedGenre, selectedStatus, selectedEra, fetchRails, fetchDirectoryPage]);

  const formatCountdown = (secs: number) => {
    if (secs <= 0) return 'Syncing...';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
  };

  const handleTriggerLiveSync = async () => {
    try {
      setIsSyncingSchedule(true);
      setSyncStatusMessage(null);
      const res = await fetch('/api/wtrlab/schedule/sync-now', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        if (Number(data.lastRefreshedAt) > 0) lastSeenSyncAtRef.current = Number(data.lastRefreshedAt);
        setCountdown(data.countdownSeconds || 0);
        setSyncStatusMessage(data.message || 'Synced live WTR-Lab feed');
        fetchRails(false);
        fetchDirectoryPage(0, sort, searchQuery, selectedGenre, selectedStatus, selectedEra, true);
      }
    } catch (err: any) {
      setSyncStatusMessage(`Sync error: ${err.message}`);
    } finally {
      setIsSyncingSchedule(false);
    }
  };

  useEffect(() => {
    setPage(0);
    setHasMore(true);
    fetchDirectoryPage(0, sort, searchQuery, selectedGenre, selectedStatus, selectedEra, true);
  }, [sort, searchQuery, selectedGenre, selectedStatus, selectedEra, fetchDirectoryPage]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || isLoading || isFetchingMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    fetchDirectoryPage(nextPage, sort, searchQuery, selectedGenre, selectedStatus, selectedEra, false);
  }, [hasMore, isLoading, isFetchingMore, page, sort, searchQuery, selectedGenre, selectedStatus, selectedEra, fetchDirectoryPage]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoading && !isFetchingMore) handleLoadMore();
      },
      { threshold: 0.1, rootMargin: '300px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoading, isFetchingMore, handleLoadMore]);

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 400);
      for (const id of ['section-daily', 'section-trending', 'section-top-rated', 'section-cultivation', 'section-all']) {
        const el = document.getElementById(id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 200 && rect.bottom >= 100) {
            setActiveSection(id);
            break;
          }
        }
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!modal.activeJobId || !modal.isOpen) {
      if (activeJobTimerRef.current) clearInterval(activeJobTimerRef.current);
      return;
    }
    const pollJob = async () => {
      try {
        const res = await fetch(`/api/jobs/${modal.activeJobId}`);
        if (!res.ok) return;
        const job = await res.json();
        setModal((prev) => ({
          ...prev,
          jobProgress: {
            currentCh: job.currentChapter || 0,
            totalCh: job.totalChapters || prev.novel?.chaptersCount || 50,
            pct: job.progress || 0,
            status: job.status || 'downloading',
            isDone: job.status === 'completed' || job.status === 'failed',
            error: job.error,
            verdict: job.buildStats?.verdict,
            errorCount: job.buildStats?.errorCount || 0,
            placeholderCount: job.buildStats?.placeholderCount || 0,
            telegramDelivered: Boolean(job.buildStats?.telegramDelivered),
            telegramBlocked: Boolean(job.buildStats?.telegramBlocked),
            telegramBlockedReason: job.buildStats?.telegramBlockedReason,
            telegramError: job.buildStats?.telegramError,
          },
        }));
        if (job.status === 'completed' || job.status === 'failed') {
          if (activeJobTimerRef.current) clearInterval(activeJobTimerRef.current);
        }
      } catch {}
    };
    pollJob();
    activeJobTimerRef.current = setInterval(pollJob, 900);
    return () => {
      if (activeJobTimerRef.current) clearInterval(activeJobTimerRef.current);
    };
  }, [modal.activeJobId, modal.isOpen]);

  const openScrapeModal = (novel: WtrlabNovelItem, mode: 'demo' | 'all' | 'custom' = 'demo') => {
    const initialId = novel.rawId || novel.id;
    setModal({
      isOpen: true,
      novel,
      mode,
      customStart: 1,
      customEnd: mode === 'demo' ? Math.min(25, novel.chaptersCount) : Math.min(100, novel.chaptersCount),
      format: 'epub',
      language: 'en',
      serviceMode: 'ai',
      sendTelegram: true,
      isStarting: false,
      isRefreshingMeta: true,
      activeJobId: null,
      modalError: null,
      verifyChapterNo: 1,
      verifyingText: false,
      verifyResult: null,
      verifyAll: null,
      jobProgress: undefined,
    });

    fetch(`/api/wtrlab/novel/${encodeURIComponent(initialId)}?refresh=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const fresh = data?.novel;
        const freshCount = Number(fresh?.totalChapters || 0);
        if (!data?.success || freshCount <= 0) {
          setModal((prev) => ({ ...prev, isRefreshingMeta: false }));
          return;
        }
        setModal((prev) => {
          if (!prev.isOpen || !prev.novel || (prev.novel.rawId || prev.novel.id) !== initialId) return prev;
          const updatedNovel: WtrlabNovelItem = {
            ...prev.novel,
            title: fresh.title || prev.novel.title,
            author: fresh.author || prev.novel.author,
            slug: fresh.slug || prev.novel.slug,
            novelUrl: fresh.novelUrl || prev.novel.novelUrl,
            description: fresh.description || prev.novel.description,
            genres: Array.isArray(fresh.genres) ? fresh.genres : prev.novel.genres,
            chaptersCount: freshCount,
            coverUrl: fresh.coverUrl || prev.novel.coverUrl,
            proxiedCoverUrl: fresh.proxiedCoverUrl || prev.novel.proxiedCoverUrl,
            status: fresh.status || prev.novel.status,
            lastUpdated: fresh.lastUpdated || prev.novel.lastUpdated,
          };
          return {
            ...prev,
            isRefreshingMeta: false,
            novel: updatedNovel,
            customEnd: prev.mode === 'all' ? freshCount : prev.customEnd,
          };
        });
      })
      .catch(() => setModal((prev) => ({ ...prev, isRefreshingMeta: false })));
  };

  const handleStartScrape = async () => {
    if (!modal.novel) return;
    setModal((prev) => ({ ...prev, isStarting: true, modalError: null }));
    try {
      const startCh = modal.mode === 'custom' ? Math.max(1, modal.customStart) : 1;
      const endCh =
        modal.mode === 'demo'
          ? Math.min(25, modal.novel.chaptersCount)
          : modal.mode === 'custom'
          ? Math.max(startCh, modal.customEnd)
          : modal.novel.chaptersCount;

      const res = await fetch('/api/jobs/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          novelUrl: modal.novel.novelUrl,
          format: modal.format,
          startCh,
          endCh,
          language: modal.language || 'en',
          serviceMode: modal.serviceMode || 'ai',
          sendTelegram: modal.sendTelegram,
          rangeMode: modal.mode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to initiate scrape job (HTTP ${res.status})`);

      if (data.job?.id) {
        setModal((prev) => ({
          ...prev,
          isStarting: false,
          activeJobId: data.job.id,
          jobProgress: { currentCh: 0, totalCh: endCh - startCh + 1, pct: 0, status: 'inspecting', isDone: false },
        }));
      }
    } catch (err: any) {
      setModal((prev) => ({ ...prev, isStarting: false, modalError: err.message }));
    }
  };

  const handleVerifyChapterText = async () => {
    if (!modal.novel) return;
    const targetCh = Math.max(1, modal.verifyChapterNo || 1);
    const novelId = modal.novel.rawId || modal.novel.id;
    setModal((prev) => ({ ...prev, verifyingText: true, modalError: null }));

    const buildId = startLocalBuild({
      title: `Verify: ${modal.novel.title} (Ch ${targetCh})`,
      novelUrl: modal.novel.novelUrl,
      sourceLabel: 'WTR-Lab Text Verify',
      format: modal.format,
      language: modal.language,
      serviceMode: modal.serviceMode,
      totalChapters: 1,
    });

    try {
      const res = await fetch('/api/wtrlab/verify-chapter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          novelId,
          chapterNo: targetCh,
          slug: modal.novel.slug,
          title: modal.novel.title,
          serviceMode: modal.serviceMode,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || 'Verification request failed');
      setModal((prev) => ({ ...prev, verifyingText: false, verifyResult: data }));
      const isOk = data.verdict === 'exact_match' || data.verdict === 'near_match';
      logLocalBuild(buildId, isOk ? 'ok' : 'error', 'verify', data.message, { chapter: targetCh, verifiedDelta: isOk ? 1 : 0 });
      finishLocalBuild(buildId, { failed: data.verdict === 'mismatch', summaryMessage: data.message });
    } catch (err: any) {
      setModal((prev) => ({ ...prev, verifyingText: false, modalError: err.message || 'Verification failed' }));
      finishLocalBuild(buildId, { failed: true });
    }
  };

  const handleVerifyAllChapters = async () => {
    if (!modal.novel) return;
    const novelId = modal.novel.rawId || modal.novel.id;
    const startCh = modal.mode === 'custom' ? Math.max(1, modal.customStart) : 1;
    const endCh = modal.mode === 'custom' ? Math.max(startCh, modal.customEnd) : Math.max(1, modal.novel.chaptersCount);

    setModal((prev) => ({ ...prev, verifyingText: true, modalError: null, verifyResult: null }));
    const buildId = startLocalBuild({
      title: `Verify All: ${modal.novel.title} (Ch ${startCh}-${endCh})`,
      novelUrl: modal.novel.novelUrl,
      sourceLabel: 'WTR-Lab Full Verify',
      format: modal.format,
      language: modal.language,
      serviceMode: modal.serviceMode,
      totalChapters: endCh - startCh + 1,
    });

    try {
      const startRes = await fetch('/api/wtrlab/verify-all/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          novelId,
          slug: modal.novel.slug,
          title: modal.novel.title,
          serviceMode: modal.serviceMode,
          startCh,
          endCh,
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok || !startData?.success || !startData.verifyId) {
        throw new Error(startData?.error || 'Could not start verification');
      }

      const verifyId: string = startData.verifyId;
      setModal((prev) => ({
        ...prev,
        verifyingText: true,
        verifyAll: {
          verifyId,
          buildId,
          status: 'running',
          totalChapters: startData.totalChapters || endCh - startCh + 1,
          checkedCount: 0,
          exactMatchCount: 0,
          nearMatchCount: 0,
          mismatchCount: 0,
          unavailableCount: 0,
          currentChapter: startCh,
          pct: 0,
          results: [],
        },
      }));

      let cursor = 0;
      while (true) {
        await new Promise((r) => setTimeout(r, 700));
        const pRes = await fetch(`/api/wtrlab/verify-all/${encodeURIComponent(verifyId)}?since=${cursor}`);
        if (!pRes.ok) break;
        const pData = await pRes.json();
        if (!pData?.success) break;

        const newItems = Array.isArray(pData.newResults) ? pData.newResults : [];
        cursor += newItems.length;
        setModal((prev) => {
          if (!prev.verifyAll || prev.verifyAll.verifyId !== verifyId) return prev;
          return {
            ...prev,
            verifyingText: pData.status === 'running',
            verifyAll: {
              ...prev.verifyAll,
              status: pData.status,
              totalChapters: pData.totalChapters,
              checkedCount: pData.checkedCount,
              exactMatchCount: pData.exactMatchCount,
              nearMatchCount: pData.nearMatchCount,
              mismatchCount: pData.mismatchCount,
              unavailableCount: pData.unavailableCount,
              currentChapter: pData.currentChapter,
              pct: pData.pct,
              results: [...prev.verifyAll.results, ...newItems],
            },
          };
        });

        if (pData.status !== 'running') {
          finishLocalBuild(buildId, {
            failed: pData.mismatchCount > 0 || pData.status === 'failed',
            summaryMessage: `Verified ${pData.checkedCount}/${pData.totalChapters}: ${pData.exactMatchCount} exact, ${pData.mismatchCount} mismatch`,
          });
          break;
        }
      }
    } catch (err: any) {
      setModal((prev) => ({ ...prev, verifyingText: false, modalError: err.message || 'Verification failed' }));
      finishLocalBuild(buildId, { failed: true });
    }
  };

  const handleCancelVerifyAll = async () => {
    if (!modal.verifyAll?.verifyId) return;
    await fetch(`/api/wtrlab/verify-all/${encodeURIComponent(modal.verifyAll.verifyId)}/cancel`, { method: 'POST' }).catch(() => {});
  };

  const handleCustomUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customUrlInput.trim()) return;
    const raw = customUrlInput.trim();
    const targetUrl = /^\d+$/.test(raw) ? `https://wtr-lab.com/en/novel/${raw}` : raw;
    if (onSelectForCrawl) onSelectForCrawl(targetUrl);
  };

  const scrollToSection = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - 80, behavior: 'smooth' });
  };

  const dailyNovels = railsData.daily.length > 0 ? railsData.daily : directoryNovels.slice(0, 10);

  return (
    <div className="w-full space-y-8">
      {/* Top Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-sky-950/40 to-slate-900 border border-sky-500/20 p-6 md:p-8 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-400/30">
                <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
                Canonical-Slug Zero-Duplicate WTR-Lab Engine
              </span>
            </div>
            <h2 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">WTR-Lab Live Novel Hub</h2>
            <p className="text-sm text-slate-300 leading-relaxed">
              Live WTR-Lab catalog with canonical slug resolution, multi-mode fallback (AI / Web+ / Web), zero-duplicate SHA-1 chapter fingerprinting, and automated Telegram EPUB/TXT delivery.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-slate-900/95 border border-sky-500/30 shadow-md">
              <Clock className="w-4 h-4 text-sky-400" />
              <div className="text-left">
                <div className="text-xs font-semibold text-white">
                  Daily Live Sync: <span className="text-sky-300 font-bold">8:30 PM IST</span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                  Next sync: <span className="text-emerald-400 font-semibold">{schedule?.syncInProgress ? 'Syncing...' : formatCountdown(countdown)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleTriggerLiveSync}
                disabled={isSyncingSchedule}
                className="ml-1 px-2.5 py-1.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer text-xs font-semibold flex items-center gap-1"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingSchedule ? 'animate-spin' : ''}`} />
                <span>{isSyncingSchedule ? 'Syncing...' : 'Sync Now'}</span>
              </button>
            </div>

            {crawlerStats && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-slate-950/90 border border-slate-800 text-[11px]">
                <div className="font-mono tabular-nums text-slate-300">
                  <span className="text-emerald-400 font-semibold">{crawlerStats.realNovelsCount.toLocaleString()}</span> synced /{' '}
                  <span className="text-sky-300 font-semibold">{(crawlerStats.remoteTotalCount || remoteTotalCount).toLocaleString()}+</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCrawlerControl(crawlerStats.paused ? 'resume' : 'pause')}
                    disabled={isControllingCrawler}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer"
                  >
                    {crawlerStats.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCrawlerControl('boost')}
                    disabled={isControllingCrawler}
                    className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 font-semibold cursor-pointer"
                  >
                    {isControllingCrawler ? 'Crawling...' : 'Sync More'}
                  </button>
                  {onOpenBuildTerminal && (
                    <button
                      type="button"
                      onClick={() => onOpenBuildTerminal()}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-emerald-300 border border-emerald-500/30 font-semibold cursor-pointer"
                    >
                      <Terminal className="w-3 h-3" />
                      <span>Terminal</span>
                    </button>
                  )}
                </div>
              </div>
            )}
            {syncStatusMessage && (
              <div className="px-3 py-1.5 rounded-lg bg-emerald-950/50 border border-emerald-700/40 text-[11px] text-emerald-300">
                {syncStatusMessage}
              </div>
            )}
          </div>
        </div>

        {/* Quick URL Jump */}
        <form onSubmit={handleCustomUrlSubmit} className="mt-6 pt-5 border-t border-sky-900/40 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Globe className="w-4 h-4 text-sky-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={customUrlInput}
              onChange={(e) => setCustomUrlInput(e.target.value)}
              placeholder="Paste WTR-Lab Novel URL or Numeric ID (e.g. https://wtr-lab.com/en/novel/7226/nine-dragon-god-emperor or 7226)"
              className="w-full pl-10 pr-4 py-2 bg-slate-950/80 border border-slate-700/80 rounded-xl text-xs text-white placeholder-slate-400 focus:outline-hidden focus:border-sky-400"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-semibold cursor-pointer whitespace-nowrap"
          >
            Open in URL Scraper
          </button>
        </form>
      </div>

      {/* Section Quick Jump Nav */}
      <div className="sticky top-16 z-20 -my-2 py-3 bg-[#090a0f]/95 backdrop-blur-md border-y border-slate-800/80 px-2 flex items-center justify-between gap-3 overflow-x-auto">
        <div className="flex items-center gap-1.5 min-w-max">
          {[
            { id: 'section-daily', label: 'Daily Updates', icon: Clock },
            { id: 'section-trending', label: 'Trending', icon: Flame },
            { id: 'section-top-rated', label: 'Top Rated', icon: Award },
            { id: 'section-cultivation', label: 'Cultivation & LitRPG', icon: Sword },
            { id: 'section-all', label: 'All Catalog & Search', icon: Library },
          ].map((nav) => {
            const NavIcon = nav.icon;
            return (
              <button
                key={nav.id}
                onClick={() => scrollToSection(nav.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                  activeSection === nav.id ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                }`}
              >
                <NavIcon className="w-3.5 h-3.5" />
                <span>{nav.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {errorMessage && (
        <div className="bg-rose-950/80 border border-rose-800 text-rose-200 px-4 py-3 rounded-xl text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => fetchDirectoryPage(0, sort, searchQuery, selectedGenre, selectedStatus, selectedEra, true)}
            className="px-2.5 py-1 bg-rose-800/60 hover:bg-rose-700 text-white rounded text-[11px] cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Horizontal Rails */}
      <section id="section-daily" className="scroll-mt-32">
        <SectionScrollRail
          title="Live Latest Updates (WTR-Lab Sync)"
          subtitle="Real-time updated novels directly from wtr-lab.com/en"
          icon={Clock}
          novels={dailyNovels}
          accentColor="sky"
          onOpenModal={openScrapeModal}
          onSelectForCrawl={onSelectForCrawl}
        />
      </section>

      <section id="section-trending" className="scroll-mt-32">
        <SectionScrollRail
          title="Trending & Community Favorites"
          subtitle="Most active web novels across action, mystery, and fantasy"
          icon={Flame}
          novels={railsData.trending}
          accentColor="amber"
          onOpenModal={openScrapeModal}
          onSelectForCrawl={onSelectForCrawl}
        />
      </section>

      <section id="section-top-rated" className="scroll-mt-32">
        <SectionScrollRail
          title="Top Rated Series"
          subtitle="Highest-rated serials ready for clean EPUB/TXT export"
          icon={Award}
          novels={railsData.topRated}
          accentColor="emerald"
          onOpenModal={openScrapeModal}
          onSelectForCrawl={onSelectForCrawl}
        />
      </section>

      <section id="section-cultivation" className="scroll-mt-32">
        <SectionScrollRail
          title="Cultivation, Xianxia & LitRPG Spotlight"
          subtitle="Martial arts, dao comprehension, and system progression"
          icon={Sword}
          novels={railsData.cultivation}
          accentColor="purple"
          onOpenModal={openScrapeModal}
          onSelectForCrawl={onSelectForCrawl}
        />
      </section>

      {/* Full Directory & Search */}
      <section id="section-all" className="space-y-6 pt-4 border-t border-slate-800/80 scroll-mt-32">
        <div className="flex flex-col gap-3 bg-slate-900/80 border border-slate-800 rounded-xl p-3.5">
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearchQuery(searchInput.trim());
              }}
              className="flex items-center gap-2 flex-1"
            >
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search WTR-Lab novels by title, author, or numeric ID..."
                  className="w-full pl-10 pr-9 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-sky-500"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setSearchQuery('');
                      setJumpIdInput('');
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <button type="submit" className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold cursor-pointer">
                Search
              </button>
            </form>

            <div className="flex items-center gap-1.5 overflow-x-auto">
              <button
                onClick={() => setSort(sort === 'newest' ? 'oldest' : 'newest')}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/30 cursor-pointer whitespace-nowrap"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                <span>Flip Order</span>
              </button>
              {(
                [
                  { id: 'daily', label: 'Latest' },
                  { id: 'newest', label: 'Newest' },
                  { id: 'popular', label: 'Popular' },
                  { id: 'rating', label: 'Rating' },
                  { id: 'chapters', label: 'Chapters' },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSort(s.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap ${
                    sort === s.id ? 'bg-sky-500 text-slate-950 font-bold' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              <span className="text-[11px] text-slate-400 font-medium mr-1">Genre:</span>
              {['All', 'Cultivation', 'Action', 'System', 'LitRPG', 'Sci-Fi', 'Mystery', 'Fantasy', 'Comedy'].map((g) => (
                <button
                  key={g}
                  onClick={() => setSelectedGenre(g)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                    selectedGenre === g
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/50 font-semibold'
                      : 'bg-slate-950/70 text-slate-400 border border-slate-800/80'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (jumpIdInput.trim()) {
                    setSearchInput(jumpIdInput.trim());
                    setSearchQuery(jumpIdInput.trim());
                  }
                }}
                className="flex items-center gap-1"
              >
                <input
                  type="text"
                  value={jumpIdInput}
                  onChange={(e) => setJumpIdInput(e.target.value)}
                  placeholder="ID (e.g. 7226)"
                  className="w-28 px-2.5 py-1 bg-slate-950 border border-slate-800 rounded text-[11px] text-slate-200"
                />
                <button type="submit" className="px-2 py-1 bg-slate-800 text-slate-200 text-[11px] rounded border border-slate-700 cursor-pointer">
                  Go
                </button>
              </form>

              {(['All', 'Ongoing', 'Completed'] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => setSelectedStatus(st)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer ${
                    selectedStatus === st ? 'bg-sky-500 text-slate-950 font-bold' : 'text-slate-400 bg-slate-950/60 border border-slate-800'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
        </div>

        {isLoading && directoryNovels.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center space-y-3">
            <Loader2 className="w-8 h-8 text-sky-400 animate-spin" />
            <p className="text-sm text-slate-400">Loading WTR-Lab live catalog...</p>
          </div>
        ) : directoryNovels.length === 0 ? (
          <div className="py-16 bg-slate-900/40 border border-slate-800 rounded-2xl flex flex-col items-center justify-center text-center p-8 space-y-3">
            <BookOpen className="w-10 h-10 text-slate-600" />
            <h3 className="text-base font-semibold text-slate-200">No WTR-Lab Novels Found</h3>
            <button
              onClick={() => {
                setSearchInput('');
                setSearchQuery('');
                setSelectedGenre('All');
                setSelectedStatus('All');
                setSelectedEra('all');
                setSort('daily');
              }}
              className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-sky-300 rounded-lg text-xs font-medium cursor-pointer"
            >
              Reset All Filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {directoryNovels.map((novel) => (
              <NovelCard key={novel.id} novel={novel} onOpenModal={openScrapeModal} onSelectForCrawl={onSelectForCrawl} />
            ))}
          </div>
        )}

        <div ref={sentinelRef} className="pt-2">
          {isFetchingMore && (
            <div className="py-6 flex items-center justify-center gap-2 text-sky-400 text-xs">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading more WTR-Lab serials...</span>
            </div>
          )}
          {hasMore && !isLoading && !isFetchingMore && directoryNovels.length > 0 && (
            <div className="py-6 flex justify-center">
              <button
                onClick={handleLoadMore}
                className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-sky-300 border border-slate-700/80 text-xs font-semibold cursor-pointer"
              >
                Load More Novels ({directoryNovels.length.toLocaleString()} loaded)
              </button>
            </div>
          )}
        </div>
      </section>

      {showScrollTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-6 right-6 p-3 bg-sky-600 hover:bg-sky-500 text-white rounded-full shadow-lg z-40 cursor-pointer"
        >
          <ArrowUp className="w-5 h-5" />
        </button>
      )}

      {/* Scrape & Verification Modal */}
      {modal.isOpen && modal.novel && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-sky-500/30 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
              <div className="flex items-center gap-2.5 min-w-0">
                <BookOpen className="w-4 h-4 text-sky-400 shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white truncate">{modal.novel.title}</h3>
                  <p className="text-[11px] text-sky-400">Clean Zero-Duplicate WTR-Lab Scraper</p>
                </div>
              </div>
              <button
                onClick={() => setModal((prev) => ({ ...prev, isOpen: false }))}
                className="p-1 rounded-lg text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              <div className="flex gap-3 bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                <img
                  src={buildFallbackCoverUrl(modal.novel)}
                  alt={modal.novel.title}
                  className="w-14 h-20 object-cover rounded-lg shrink-0 border border-slate-800"
                />
                <div className="flex-1 min-w-0">
                  <h4 className="text-xs font-bold text-white truncate">{modal.novel.title}</h4>
                  <p className="text-[11px] text-slate-400">Author: {modal.novel.author}</p>
                  <p className="text-[11px] text-slate-400 flex items-center gap-2">
                    <span>
                      Chapters: <strong className="text-sky-300 font-mono">{modal.novel.chaptersCount.toLocaleString()}</strong>
                    </span>
                    {modal.isRefreshingMeta && (
                      <span className="text-[10px] text-sky-400 inline-flex items-center gap-1">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Syncing live...
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {/* Range Mode */}
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { id: 'demo', title: 'Demo', sub: `1 to ${Math.min(25, modal.novel.chaptersCount)}` },
                    { id: 'all', title: 'All Chapters', sub: `1 to ${modal.novel.chaptersCount}` },
                    { id: 'custom', title: 'Custom Range', sub: 'Pick Start / End' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModal((prev) => ({ ...prev, mode: m.id }))}
                    className={`p-2.5 rounded-xl text-center border text-xs font-semibold cursor-pointer ${
                      modal.mode === m.id ? 'bg-sky-500/20 border-sky-500 text-sky-300' : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    <div>{m.title}</div>
                    <div className="text-[10px] font-normal text-slate-400 mt-0.5">{m.sub}</div>
                  </button>
                ))}
              </div>

              {modal.mode === 'custom' && (
                <div className="grid grid-cols-2 gap-3 bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                  <div>
                    <label className="text-[11px] text-slate-400 mb-1 block">Start Chapter</label>
                    <input
                      type="number"
                      min={1}
                      value={modal.customStart}
                      onChange={(e) => setModal((prev) => ({ ...prev, customStart: parseInt(e.target.value, 10) || 1 }))}
                      className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-400 mb-1 block">End Chapter</label>
                    <input
                      type="number"
                      min={1}
                      value={modal.customEnd}
                      onChange={(e) => setModal((prev) => ({ ...prev, customEnd: parseInt(e.target.value, 10) || 50 }))}
                      className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white font-mono"
                    />
                  </div>
                </div>
              )}

              {/* Service Mode & Language */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 mb-1.5 block">Translation Mode</label>
                  <div className="grid grid-cols-3 rounded-lg border border-slate-800 bg-slate-950 overflow-hidden text-xs font-semibold">
                    {(['web', 'webplus', 'ai'] as const).map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setModal((prev) => ({ ...prev, serviceMode: id }))}
                        className={`py-2 text-center cursor-pointer ${
                          modal.serviceMode === id ? 'bg-sky-500/20 text-sky-300 font-bold' : 'text-slate-400'
                        }`}
                      >
                        {id === 'webplus' ? 'Web+' : id.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 mb-1.5 block">Output Language</label>
                  <div className="grid grid-cols-2 rounded-lg border border-slate-800 bg-slate-950 overflow-hidden text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => setModal((prev) => ({ ...prev, language: 'en' }))}
                      className={`py-2 text-center cursor-pointer ${modal.language === 'en' ? 'bg-blue-600/20 text-blue-300 font-bold' : 'text-slate-400'}`}
                    >
                      English
                    </button>
                    <button
                      type="button"
                      onClick={() => setModal((prev) => ({ ...prev, language: 'hi' }))}
                      className={`py-2 text-center cursor-pointer ${modal.language === 'hi' ? 'bg-emerald-600/20 text-emerald-300 font-bold' : 'text-slate-400'}`}
                    >
                      Hindi
                    </button>
                  </div>
                </div>
              </div>

              {/* Verify Controls */}
              <div className="p-3 rounded-xl bg-slate-950/75 border border-slate-800 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                    <FileCheck2 className="w-4 h-4 text-emerald-400" />
                    <span>Live WTR-Lab Parity & Duplicate Check</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleVerifyAllChapters}
                      disabled={modal.verifyingText}
                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold cursor-pointer"
                    >
                      {modal.verifyAll?.status === 'running'
                        ? `${modal.verifyAll.checkedCount}/${modal.verifyAll.totalChapters}`
                        : 'Verify Range'}
                    </button>
                    {modal.verifyAll?.status === 'running' && (
                      <button
                        type="button"
                        onClick={handleCancelVerifyAll}
                        className="px-2 py-1 bg-rose-950 text-rose-300 border border-rose-500/40 rounded text-xs cursor-pointer"
                      >
                        Stop
                      </button>
                    )}
                    <input
                      type="number"
                      min={1}
                      value={modal.verifyChapterNo || 1}
                      onChange={(e) => setModal((prev) => ({ ...prev, verifyChapterNo: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                      className="w-14 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleVerifyChapterText}
                      disabled={modal.verifyingText}
                      className="px-2 py-1 bg-slate-800 text-slate-200 rounded text-xs cursor-pointer"
                    >
                      1 Ch
                    </button>
                  </div>
                </div>

                {modal.verifyResult && (
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-200 space-y-1">
                    <div className="flex justify-between font-semibold">
                      <span>{modal.verifyResult.message}</span>
                      <span className="font-mono text-emerald-400">{modal.verifyResult.similarityPct}%</span>
                    </div>
                  </div>
                )}
              </div>

              {modal.modalError && (
                <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800/60 text-xs text-rose-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                  <span>{modal.modalError}</span>
                </div>
              )}

              {modal.jobProgress && (
                <div className="bg-slate-950 p-3.5 rounded-xl border border-sky-500/40 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">
                      {modal.jobProgress.isDone
                        ? modal.jobProgress.telegramBlocked || modal.jobProgress.status === 'failed'
                          ? 'Verification Blocked'
                          : 'Verified & Complete!'
                        : `${modal.jobProgress.status}... (${modal.jobProgress.currentCh}/${modal.jobProgress.totalCh})`}
                    </span>
                    <span className="font-mono text-sky-400 font-bold">{modal.jobProgress.pct}%</span>
                  </div>
                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        modal.jobProgress.telegramBlocked || modal.jobProgress.status === 'failed'
                          ? 'bg-rose-500'
                          : 'bg-gradient-to-r from-sky-500 to-emerald-400'
                      }`}
                      style={{ width: `${modal.jobProgress.pct}%` }}
                    />
                  </div>
                  {modal.jobProgress.isDone && !(modal.jobProgress.telegramBlocked || modal.jobProgress.status === 'failed') && (
                    <div className="pt-1 flex justify-end">
                      <a
                        href={`/api/jobs/${modal.activeJobId}/download`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download {modal.format.toUpperCase()}</span>
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setModal((prev) => ({ ...prev, isOpen: false }))}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleStartScrape}
                disabled={modal.isStarting || Boolean(modal.jobProgress && !modal.jobProgress.isDone)}
                className="inline-flex items-center gap-2 px-5 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-bold cursor-pointer disabled:opacity-50"
              >
                {modal.isStarting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>{modal.isStarting ? 'Starting...' : 'Start Scrape & Telegram Dispatch'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
