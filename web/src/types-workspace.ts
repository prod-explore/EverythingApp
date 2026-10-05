// ─── N3: workspace ───────────────────────────────────────────────────────────
export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: string | null;
  target?: string;
}
export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  truncated?: boolean;
  empty?: boolean;
}
export interface Checkpoint {
  id: string;
  label: string;
  commit?: string;
  createdAt: string;
}

// ─── N4: GitHub + Source Control ─────────────────────────────────────────────
export interface GithubStatus {
  connected: boolean;
  method: 'app' | 'pat' | 'env' | null;
  login: string | null;
  appConfigured: boolean;
  vaultEnabled: boolean;
  error?: string;
}
export type PushMode = 'ask' | 'allow' | 'deny';
export interface ProjectRepo {
  id: string;
  projectId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  pushMode: PushMode;
  createdAt: string;
}
export interface ScmFile {
  path: string;
  origPath?: string;
  index: string;
  worktree: string;
  conflicted: boolean;
}
export interface ScmStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ScmFile[];
}
export interface ScmBranch {
  current: boolean;
  name: string;
  upstream: string | null;
  track: string | null;
  sha: string;
}
export interface ScmCommit {
  sha: string;
  parents: string[];
  author: string;
  date: string;
  refs: string[];
  subject: string;
}
