import type { Diagnostic } from '../errors.js';
import type { MergedEntryRecord } from '../lockfile.js';
import type { Target } from '../manifest.js';
import type { PackageContent } from '../package.js';

export type Scope = 'project' | 'user';

/** Fichier entier écrit par un adaptateur. Chemin POSIX relatif à la racine de la portée. */
export interface FileOp {
  path: string;
  bytes: Buffer;
  executable?: boolean;
  primitive: 'skill' | 'agent' | 'command' | 'instruction' | 'hook';
  target: Target;
}

/** Entrées à fusionner dans un fichier de configuration partagé. */
export interface MergeOp {
  path: string;
  format: 'json' | 'toml';
  kind: 'mcp' | 'hooks';
  target: Target;
  entries: MergedEntryRecord[];
}

/** Élément exécutable porté à l'attention de l'utilisateur avant confirmation. */
export interface ExecutableNotice {
  kind: 'hook' | 'mcp';
  target: Target;
  name: string;
  /** Événement de hook, ou transport MCP. */
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
  /** Identifiant court et sûr du paquet, utilisé dans les noms de fichiers générés. */
  packageSlug: string;
  /** Écrit les skills dans les dossiers natifs (`.github/skills`, `.cursor/skills`) plutôt que `.agents/skills`. */
  legacySkillPaths?: boolean;
  /** Sous-ensemble de skills demandé (`skills:` de la dépendance). */
  skillSubset?: string[];
}

export type Adapter = (content: PackageContent, ctx: AdapterContext) => AdapterResult;
