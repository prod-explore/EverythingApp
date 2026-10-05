import { randomBytes } from 'node:crypto';
import { META_DIR_NAME, WORKSPACE } from './explorer.js';

/**
 * Checkpoints / rollback of /workspace, implemented with git INSIDE the sandbox (via exec; nothing runs
 * on the host). A separate git dir (/workspace/.ea-checkpoints) keeps it out of the way of any repo the
 * user has: the top-level /workspace/.git is never touched (git always skips `.git` entries), and the
 * user's .gitignore files are honoured, so ignored trees such as node_modules are neither snapshotted
 * nor deleted by a rollback.
 *
 * Known limitation: a NESTED repository (e.g. /workspace/app/.git) is recorded by git as a gitlink only,
 * so its files are not part of the snapshot (one without any commit is skipped). git's messages about
 * them are handed back as `warnings`.
 *
 * Every user-supplied string (the label) reaches the shell as base64, never as shell syntax; checkpoint
 * ids are validated against a strict pattern before they are interpolated.
 */

export interface Checkpoint {
  id: string;
  label: string;
  commit: string;
  /** ISO timestamp. */
  createdAt: string;
}

const ID_RE = /^[a-z0-9]{1,16}-[a-f0-9]{4,16}$/;
export const validCheckpointId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

export function newCheckpointId(now: number): string {
  return `${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Common prelude: the checkpoint repo env. Identity is passed explicitly (HOME is a tmpfs, global config is gone). */
const prelude = (ws: string) =>
  [
    'set -e',
    `export GIT_DIR='${ws}/${META_DIR_NAME}' GIT_WORK_TREE='${ws}'`,
    'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0',
    `G() { git -c user.name='EverythingApp Checkpoint' -c user.email='checkpoint@everythingapp' -c core.hooksPath=/dev/null -c safe.directory='*' -c commit.gpgsign=false -c core.autocrlf=false "$@"; }`,
  ].join('\n');

export function checkpointScript(id: string, label: string, ws = WORKSPACE): string {
  if (!validCheckpointId(id)) throw new Error('invalid checkpoint id');
  return [
    prelude(ws),
    `if [ ! -f "$GIT_DIR/HEAD" ]; then mkdir -p "$GIT_DIR" && G init -q && mkdir -p "$GIT_DIR/info" && printf '/${META_DIR_NAME}/\\n' > "$GIT_DIR/info/exclude"; fi`,
    // Nested repos make `add` warn (gitlink) or even error (no commit checked out); --ignore-errors keeps the
    // rest of the snapshot going and the messages are handed back as warnings.
    `G add -A --ignore-errors 2>"$GIT_DIR/ea-add.err" || true`,
    `printf %s '${b64(label)}' | base64 -d | G commit -q --allow-empty --allow-empty-message --no-verify -F -`,
    `G tag 'cp-${id}'`,
    `printf 'commit=%s\\n' "$(G rev-parse HEAD)"`,
    `sed -n 's/^\\(warning\\|error\\|fatal\\): /warn=/p' "$GIT_DIR/ea-add.err" || true`,
    `rm -f "$GIT_DIR/ea-add.err"`,
  ].join('\n');
}

export function parseCheckpointOutput(stdout: string): { commit: string; warnings: string[] } {
  let commit = '';
  const warnings: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('commit=')) commit = line.slice(7).trim();
    else if (line.startsWith('warn=')) warnings.push(line.slice(5).trim());
  }
  return { commit, warnings };
}

/** Newest first. Prints nothing when no checkpoint was ever taken. */
export function listScript(ws = WORKSPACE): string {
  return [
    prelude(ws),
    `[ -f "$GIT_DIR/HEAD" ] || exit 0`,
    `G for-each-ref --sort=-creatordate --format='%(refname:strip=2)%00%(objectname)%00%(creatordate:unix)%00%(contents:subject)' 'refs/tags/cp-*'`,
  ].join('\n');
}

export function parseListOutput(stdout: string): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [ref, commit, unix, label] = line.split('\0');
    if (!ref?.startsWith('cp-') || !commit) continue;
    const id = ref.slice(3);
    if (!validCheckpointId(id)) continue;
    out.push({ id, label: label ?? '', commit, createdAt: new Date(Number(unix) * 1000).toISOString() });
  }
  return out;
}

/** Exit code 3 = no such checkpoint. Restores tracked files and removes untracked (non-ignored) ones. */
export const ROLLBACK_NOT_FOUND = 3;
export function rollbackScript(id: string, ws = WORKSPACE): string {
  if (!validCheckpointId(id)) throw new Error('invalid checkpoint id');
  return [
    prelude(ws),
    `[ -f "$GIT_DIR/HEAD" ] || exit ${ROLLBACK_NOT_FOUND}`,
    `G rev-parse -q --verify 'refs/tags/cp-${id}^{commit}' >/dev/null || exit ${ROLLBACK_NOT_FOUND}`,
    `G reset -q --hard 'refs/tags/cp-${id}'`,
    // -e is belt and braces: the meta dir is already excluded via info/exclude, and clean never enters nested repos.
    `G clean -fdq -e '/${META_DIR_NAME}/'`,
    `printf 'commit=%s\\n' "$(G rev-parse HEAD)"`,
  ].join('\n');
}
