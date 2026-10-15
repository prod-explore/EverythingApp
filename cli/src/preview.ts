import { createHash } from 'node:crypto';
import type * as Llm from './llm-types.js';
import type { VirtualTool } from './llm-loop.js';

/**
 * Looking at what the agent builds. There is ONE browser (the one the user watches and the agent drives). To let it reach
 * a dev server inside the chat's sandbox, the supervisor links the two over a private network that has no route out and
 * gives the sandbox a hostname on it: `sandbox-<10 hex>`. Nothing else becomes reachable — the browser still refuses every
 * other private address — and the link is cut when the sandbox stops.
 */

/**
 * The hostname of an owner's sandbox as seen by the browser. The same function lives in the supervisor
 * (sandbox-supervisor/src/sandboxes.ts); both tests pin the same vector (`abc` → `sandbox-a9993e3647`).
 */
export function previewHostFor(owner: string): string {
  return `sandbox-${createHash('sha1').update(owner).digest('hex').slice(0, 10)}`;
}

export const PREVIEW_TOOL: Llm.Tool = {
  name: 'preview_sandbox',
  description:
    'Make a server that runs in the workspace sandbox reachable for the browser, so you (and the user, who watches the same browser) can look at the app you are building. ' +
    'Start the dev server first, in a separate terminal, listening on 0.0.0.0 (not 127.0.0.1 — e.g. `vite --host 0.0.0.0`, `next dev -H 0.0.0.0`, `flask run --host 0.0.0.0`, `python3 -m http.server --bind 0.0.0.0`). ' +
    'Returns the URL to open with browser_open. The user is not asked to approve this.',
  input_schema: {
    type: 'object',
    properties: { port: { type: 'integer', description: 'The port the server listens on inside the sandbox, e.g. 5173.' } },
    required: ['port'],
  },
};

export const PREVIEW_PROMPT =
  'To look at an app you are building, run its dev server in the sandbox (listening on 0.0.0.0), call preview_sandbox with the port, and open the returned URL with browser_open. ' +
  'It is the same browser the user watches. Other private addresses stay out of reach.';

export interface PreviewToolDeps {
  owner: string;
  /** Links the owner's sandbox and the browser (supervisor POST /preview). */
  link: (owner: string) => Promise<{ host: string }>;
}

export function previewTool(deps: PreviewToolDeps): VirtualTool {
  return {
    definition: PREVIEW_TOOL,
    handler: async input => {
      const port = typeof input['port'] === 'number' ? input['port'] : Number(input['port']);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { text: 'preview_sandbox needs "port" to be an integer between 1 and 65535.', isError: true };
      try {
        const { host } = await deps.link(deps.owner);
        return {
          text:
            `Open http://${host}:${port}/ with browser_open. It works only while a server listens on 0.0.0.0:${port} inside the sandbox ` +
            `(a server bound to 127.0.0.1 cannot be reached — restart it with --host 0.0.0.0). The link is cut when the sandbox stops; call this tool again after a restart.`,
        };
      } catch (e) {
        return { text: `Could not set up the preview: ${(e as Error).message}`, isError: true };
      }
    },
  };
}
