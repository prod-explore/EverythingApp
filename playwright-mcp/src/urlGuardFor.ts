import type { PlaywrightConfig } from './config.js';
import { UrlGuard } from './urlSafety.js';

const guards = new WeakMap<PlaywrightConfig, UrlGuard>();

/** One UrlGuard (and DNS cache) per config object, shared by every tool and launcher. */
export function guardFor(config: PlaywrightConfig): UrlGuard {
  let g = guards.get(config);
  if (!g) {
    g = new UrlGuard({ allowHosts: config.allowPrivateHosts });
    guards.set(config, g);
  }
  return g;
}
