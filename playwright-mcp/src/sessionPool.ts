import { chromium, type BrowserContext, type Page } from 'playwright';
import { installRequestGuard, type UrlGuard } from './urlSafety.js';

/**
 * Browser-agent equivalent of sandbox-supervisor/src/pool.ts's sticky lease +
 * idle watchdog — same shape, deliberately, since it's the same problem: a
 * conversation gets the same live resource back across multiple tool calls
 * (§6b's "works with app closed, reconnect" requirement), and idle resources
 * get reclaimed so one forgotten tab doesn't sit open forever.
 *
 * Unlike the sandbox pool, sessions aren't pre-warmed — a Chromium process
 * per idle slot isn't worth the RAM on a Pi-sized box, so sessions are
 * created lazily on first use and capped at maxSessions concurrent.
 */

export interface SessionHandle {
  readonly id: string; // = conversationId — one session per conversation, sticky
  readonly context: BrowserContext;
  readonly page: Page;
  readonly createdAt: Date;
  lastActivityAt: Date;
  currentUrl: string | null;
}

/** Seam for tests — real launch requires a Chromium binary this container may not have. */
export interface ContextLauncher {
  launch(): Promise<{ context: BrowserContext; page: Page }>;
}

/** One Chromium process per session, using a per-session subdirectory of the
 * shared profile dir: each session's cookies/localStorage persist across
 * restarts (the "log in once" requirement), but sessions don't bleed into
 * each other by sharing one profile. */
export class ChromiumLauncher implements ContextLauncher {
  constructor(
    private readonly profileDir: string,
    private readonly sessionId: string,
    /** Applied to every request the browser makes (SSRF guard). */
    private readonly guard?: UrlGuard,
  ) {}

  async launch(): Promise<{ context: BrowserContext; page: Page }> {
    const dir = `${this.profileDir}/${this.sessionId}`;
    const context = await chromium.launchPersistentContext(dir, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // Pi has limited /dev/shm
        '--disable-gpu',
      ],
      userAgent: 'Mozilla/5.0 (compatible; EverythingAppBot/1.0; +https://futumore.pl)',
    });
    if (this.guard) await installRequestGuard(context, this.guard, url => console.warn(`[ssrf-guard] blocked request to ${url}`));
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page };
  }
}

export interface SessionPoolOptions {
  maxSessions: number;
  idleTimeoutMs: number;
  watchdogIntervalMs: number;
  /** Overridable in tests so no real browser is ever launched there. */
  makeLauncher: (sessionId: string) => ContextLauncher;
}

export class SessionLimitError extends Error {
  constructor(max: number) {
    super(
      `Browser session limit reached (${max} concurrent tabs). ` +
        `Close an existing session (browser_close) or wait for an idle one to time out.`,
    );
    this.name = 'SessionLimitError';
  }
}

export class BrowserSessionPool {
  private readonly sessions = new Map<string, SessionHandle>();
  private watchdogHandle: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionPoolOptions) {}

  /** Sticky: the same conversationId always gets the same live session back. */
  async claim(conversationId: string): Promise<{ session: SessionHandle; isNew: boolean }> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      existing.lastActivityAt = new Date();
      return { session: existing, isNew: false };
    }

    if (this.sessions.size >= this.opts.maxSessions) {
      throw new SessionLimitError(this.opts.maxSessions);
    }

    const launcher = this.opts.makeLauncher(conversationId);
    const { context, page } = await launcher.launch();
    const handle: SessionHandle = {
      id: conversationId,
      context,
      page,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      currentUrl: null,
    };
    this.sessions.set(conversationId, handle);
    this.ensureWatchdog();
    console.log(`[sessionPool] opened session ${conversationId.slice(0, 8)} (${this.sessions.size}/${this.opts.maxSessions})`);
    return { session: handle, isNew: true };
  }

  get(conversationId: string): SessionHandle | undefined {
    return this.sessions.get(conversationId);
  }

  touch(conversationId: string): void {
    const s = this.sessions.get(conversationId);
    if (s) s.lastActivityAt = new Date();
  }

  setCurrentUrl(conversationId: string, url: string): void {
    const s = this.sessions.get(conversationId);
    if (s) s.currentUrl = url;
  }

  async close(conversationId: string, reason: string): Promise<boolean> {
    const s = this.sessions.get(conversationId);
    if (!s) return false;
    this.sessions.delete(conversationId);
    console.log(`[sessionPool] closing session ${conversationId.slice(0, 8)} — ${reason}`);
    try {
      await s.context.close();
    } catch (err) {
      console.error(`[sessionPool] error closing session ${conversationId.slice(0, 8)}:`, err);
    }
    return true;
  }

  status(): {
    total: number;
    max: number;
    sessions: Array<{ id: string; url: string | null; idleSinceMs: number }>;
  } {
    const now = Date.now();
    return {
      total: this.sessions.size,
      max: this.opts.maxSessions,
      sessions: [...this.sessions.values()].map(s => ({
        id: s.id,
        url: s.currentUrl,
        idleSinceMs: now - s.lastActivityAt.getTime(),
      })),
    };
  }

  private ensureWatchdog(): void {
    if (this.watchdogHandle) return;
    this.watchdogHandle = setInterval(() => this.sweepIdle(), this.opts.watchdogIntervalMs);
    this.watchdogHandle.unref?.();
  }

  /** Closes every session idle past idleTimeoutMs. Called by the watchdog interval;
   * exposed publicly so tests can trigger a sweep deterministically instead of
   * waiting on a real timer. */
  sweepIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const idleMs = now - s.lastActivityAt.getTime();
      if (idleMs > this.opts.idleTimeoutMs) {
        const idleMin = Math.round(idleMs / 60_000);
        this.close(id, `idle timeout, idle ${idleMin}m`).catch(err =>
          console.error('[sessionPool] watchdog close error:', err),
        );
      }
    }
  }

  /** Stops the watchdog without closing sessions — for tests and graceful shutdown. */
  stopWatchdog(): void {
    if (this.watchdogHandle) clearInterval(this.watchdogHandle);
    this.watchdogHandle = null;
  }
}
