import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Download, type FileChooser, type Page } from 'playwright';
import { checkNavigation, checkRequest, jsContextOptions, OPEN_POLICY, type EffectivePolicy, type PolicyOverride } from './policy.js';
import type { UrlGuard } from './urlSafety.js';

/**
 * One place that creates every browser context (sessions and one-shot browse_url alike), with the
 * N3b lockdown: ephemeral profile, domain/JS policy, no downloads/uploads unless the orchestrator
 * passed `_allow_downloads`, no permissions, WebRTC leak protection, no extensions, blocked
 * chrome:/file:/devtools: schemes, and the private-network SSRF guard on every request.
 */

/** Mutable per-session state the route/download handlers consult on every event. */
export interface SessionState {
  policy: EffectivePolicy;
  /** The last `_policy` override the orchestrator sent — sticky for calls that omit it. */
  override?: PolicyOverride;
  /** Set per call from `_allow_downloads`; reset after the call. */
  allowDownloads: boolean;
  /** Security-relevant events since the last tool result (blocked navigations, downloads…). Drained by tools. */
  events: string[];
}

export function newSessionState(policy: EffectivePolicy = OPEN_POLICY, override?: PolicyOverride): SessionState {
  return { policy, override, allowDownloads: false, events: [] };
}

export function drainEvents(state: SessionState): string[] {
  return state.events.splice(0, state.events.length);
}

const MAX_EVENTS = 50;
function pushEvent(state: SessionState, ev: string): void {
  if (state.events.includes(ev)) return;
  state.events.push(ev);
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

/**
 * Chromium launch flags. Note: `--disable-features=WebRtcHideLocalIpsWithMdns` would EXPOSE local
 * IPs (it turns off mDNS obfuscation), so it is deliberately not used; the IP-handling policy plus
 * removing RTCPeerConnection in the init script is what prevents the leak. No extra
 * `--disable-features=` either: Chromium honours only the last one, which would silently replace
 * the list Playwright itself passes.
 */
export function chromiumLaunchArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Pi has limited /dev/shm
    '--disable-gpu',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--deny-permission-prompts',
    '--disable-notifications',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}

export const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; EverythingAppBot/1.0; +https://futumore.pl)';

/** Context options for a policy. Always a fresh, in-memory profile: no storageState, nothing persisted. */
export function contextOptionsFor(policy: EffectivePolicy): BrowserContextOptions {
  return {
    userAgent: BOT_USER_AGENT,
    ...jsContextOptions(policy.js),
    // Downloads are accepted at the context level only so they can be decided per call: the
    // download handler cancels every one unless the orchestrator passed `_allow_downloads`.
    acceptDownloads: true,
    serviceWorkers: 'block',
    permissions: [],
    bypassCSP: false,
    storageState: undefined,
  };
}

/**
 * Runs in every page before any page script (Playwright serialises it — must be self-contained).
 * Belt-and-braces over `permissions: []` + `--deny-permission-prompts`: camera/mic/screen capture,
 * geolocation, clipboard and notifications all fail closed, and WebRTC is removed outright.
 */
export function lockdownInitScript(): void {
  const deny = (): Promise<never> =>
    Promise.reject(new DOMException('Blocked by EverythingApp browser policy', 'NotAllowedError'));
  const def = (obj: object | undefined | null, key: string, value: unknown): void => {
    if (!obj) return;
    try {
      Object.defineProperty(obj, key, { value, configurable: false, writable: false });
    } catch {
      /* ignore */
    }
  };
  const nav = navigator as unknown as Record<string, unknown>;
  const md = nav['mediaDevices'] as object | undefined;
  def(md, 'getUserMedia', deny);
  def(md, 'getDisplayMedia', deny);
  def(md, 'enumerateDevices', () => Promise.resolve([]));
  const geo = nav['geolocation'] as object | undefined;
  def(geo, 'getCurrentPosition', (_ok: unknown, err?: (e: unknown) => void) =>
    err?.({ code: 1, message: 'Blocked by EverythingApp browser policy', PERMISSION_DENIED: 1 }),
  );
  def(geo, 'watchPosition', (_ok: unknown, err?: (e: unknown) => void) => {
    err?.({ code: 1, message: 'Blocked by EverythingApp browser policy', PERMISSION_DENIED: 1 });
    return 0;
  });
  const clip = nav['clipboard'] as object | undefined;
  def(clip, 'readText', deny);
  def(clip, 'read', deny);
  def(clip, 'writeText', deny);
  def(clip, 'write', deny);
  const w = window as unknown as Record<string, unknown>;
  const N = w['Notification'] as Record<string, unknown> | undefined;
  if (N) def(N, 'requestPermission', () => Promise.resolve('denied'));
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCRtpSender', 'RTCRtpReceiver']) {
    try {
      Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false });
    } catch {
      /* ignore */
    }
  }
}

export interface RouteDecision {
  allow: boolean;
  reason?: string;
}

/**
 * The per-request decision, separated from Playwright for testability. Order: scheme + domain policy
 * (cheap, no DNS), then the SSRF guard. Top-level navigations also need the allowlist.
 */
export async function decideRequest(
  state: SessionState,
  guard: Pick<UrlGuard, 'check'> | undefined,
  url: string,
  isTopLevelNavigation: boolean,
): Promise<RouteDecision> {
  const d = isTopLevelNavigation ? checkNavigation(state.policy, url) : checkRequest(state.policy, url);
  if (!d.allowed) return { allow: false, reason: d.reason };
  if (guard && !/^(data|blob):/i.test(url)) {
    try {
      await guard.check(url);
    } catch (err) {
      return { allow: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { allow: true };
}

function isTopLevelNav(req: import('playwright').Request): boolean {
  try {
    return req.isNavigationRequest() && req.frame().parentFrame() === null;
  } catch {
    return false; // service-worker requests have no frame
  }
}

export function handleDownload(state: SessionState, download: Pick<Download, 'cancel' | 'suggestedFilename' | 'url'>): void {
  const name = safeName(download.suggestedFilename());
  if (state.allowDownloads) {
    pushEvent(state, `download allowed (kept only in the ephemeral session, deleted when it closes): ${name}`);
    return;
  }
  void download.cancel().catch(() => {});
  pushEvent(state, `download blocked: ${name} — downloads need explicit user permission (ask the user)`);
}

export function handleFileChooser(state: SessionState, _chooser?: FileChooser): void {
  // Having a listener suppresses the native dialog; no files are ever set by this server.
  pushEvent(
    state,
    state.allowDownloads
      ? 'file upload dialog opened — this browser tool cannot upload files'
      : 'file upload blocked — uploads need explicit user permission (ask the user)',
  );
}

function safeName(s: string): string {
  return s.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || '(unnamed)';
}

export function attachPageHandlers(page: Page, state: SessionState): void {
  page.on('download', d => handleDownload(state, d));
  page.on('filechooser', fc => handleFileChooser(state, fc));
  page.on('dialog', d => void d.dismiss().catch(() => {}));
}

export async function installPolicyRoutes(
  context: BrowserContext,
  state: SessionState,
  guard: UrlGuard | undefined,
): Promise<void> {
  await context.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    const top = isTopLevelNav(req);
    const d = await decideRequest(state, guard, url, top);
    if (d.allow) {
      await route.continue().catch(() => {});
      return;
    }
    if (top) pushEvent(state, `navigation blocked: ${d.reason}`);
    else console.warn(`[browser-policy] blocked request to ${url}: ${d.reason}`);
    await route.abort('blockedbyclient').catch(() => {});
  });
}

export interface HardenedContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/** Launches Chromium + one ephemeral, locked-down context + its first page. */
export async function launchHardenedContext(state: SessionState, guard?: UrlGuard): Promise<HardenedContext> {
  const browser = await chromium.launch({ headless: true, args: chromiumLaunchArgs() });
  try {
    const context = await browser.newContext(contextOptionsFor(state.policy));
    // A context made by browser.newContext() does not stop the browser process when closed;
    // tie them together so closing a session never leaves a Chromium behind.
    context.once('close', () => void browser.close().catch(() => {}));
    await context.addInitScript(lockdownInitScript);
    await installPolicyRoutes(context, state, guard);
    context.on('page', p => attachPageHandlers(p, state));
    const page = await context.newPage();
    return { browser, context, page };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
