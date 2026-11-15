import type { Diagnostic } from '../errors.js';
import type { MergedEntryRecord } from '../lockfile.js';
import type { Target } from '../manifest.js';
import type { PackageContent } from '../package.js';

export type Scope = 'project' | 'user';

/** Whole file written by an adapter. POSIX path relative to the root of the scope. */
export interface FileOp {
  path: string;
  bytes: Buffer;
  executable?: boolean;
  primitive: 'skill' | 'agent' | 'command' | 'instruction' | 'hook';
  target: Target;
}

/** Entries to merge into a shared configuration file. */
export interface MergeOp {
  path: string;
  format: 'json' | 'toml';
  kind: 'mcp' | 'hooks';
  target: Target;
  entries: MergedEntryRecord[];
}

/** Executable item brought to the user's attention before confirmation. */
export interface ExecutableNotice {
  kind: 'hook' | 'mcp';
  target: Target;
  name: string;
  /** Hook event, or MCP transport. */
  detail: string;
  command: string;
}

export interface AdapterResult {
  files: FileOp[];
  merges: MergeOp[];
  executables: ExecutableNotice[];
  diagnostics: Diagnostic[];
}

export interface AdapterContext {
  scope: Scope;
  /** Short, safe identifier of the package, used in the names of generated files. */
  packageSlug: string;
  /** Writes skills to the native folders (`.github/skills`, `.cursor/skills`) rather than `.agents/skills`. */
  legacySkillPaths?: boolean;
  /** Requested subset of skills (`skills:` of the dependency). */
  skillSubset?: string[];
}

export type Adapter = (content: PackageContent, ctx: AdapterContext) => AdapterResult;
