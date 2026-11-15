import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AhubError } from './errors.js';
import { canonicalTreeHash, sha256Hex, type TreeEntry } from './hash.js';
import { t } from './i18n.js';

export interface GitOptions {
  /** Folder of the local git mirrors. */
  cacheDir: string;
  /**
   * URL replacements: identity `host/owner/repo` → real URL or path.
   * Used by the tests (local repositories) and by company mirrors.
   */
  mirrors?: Record<string, string>;
}

/**
 * Configuration forced on every git call: no prompt, no hook,
 * no materialised symbolic link, no exotic protocol.
 */
const SAFE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.symlinks=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'advice.detachedHead=false',
  '-c',
  'gc.auto=0',
];

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: 'echo',
    LC_ALL: 'C',
    ...extra,
  };
}

/** Never exposes credentials present in a URL. */
function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');
}

export function git(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd: opts.cwd, env: gitEnv(opts.env), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = redact(String(stderr || err.message).trim());
          reject(
            new AhubError('GIT_FAILED', t('git {0} failed: {1}', [redact(args[0] ?? ''), detail]), {
              args: args.map(redact),
            }),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AHUB_CACHE_DIR) return env.AHUB_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'ahub');
}

export interface RemoteRefs {
  /** Commit HEAD points to. */
  head?: string;
  defaultBranch?: string;
  /** Tag name → commit (annotated tags already dereferenced, req-rs-002). */
  tags: Map<string, string>;
  branches: Map<string, string>;
}

/** Lists the remote references without cloning anything. */
export async function lsRemote(url: string): Promise<RemoteRefs> {
  const out = await git(['ls-remote', '--symref', '--', url]);
  const refs: RemoteRefs = { tags: new Map(), branches: new Map() };
  for (const line of out.split('\n')) {
    if (!line) continue;
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) {
      refs.defaultBranch = sym[1];
      continue;
    }
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (!m) continue;
    const [, sha, name] = m as unknown as [string, string, string];
    if (name === 'HEAD') refs.head = sha;
    else if (name.startsWith('refs/heads/')) refs.branches.set(name.slice(11), sha);
    else if (name.startsWith('refs/tags/')) {
      const tag = name.slice(10);
      if (tag.endsWith('^{}')) refs.tags.set(tag.slice(0, -3), sha);
      else if (!refs.tags.has(tag)) refs.tags.set(tag, sha);
    }
  }
  return refs;
}

/** Creates or updates the local mirror of a repository; returns its git folder. */
export async function ensureMirror(url: string, opts: GitOptions, refresh = true): Promise<string> {
  const dir = path.join(opts.cacheDir, 'git', createHash('sha256').update(url).digest('hex').slice(0, 32));
  if (existsSync(path.join(dir, 'HEAD'))) {
    if (refresh)
      await git(['--git-dir', dir, 'fetch', '--quiet', '--prune', '--force', 'origin', '+refs/*:refs/*']);
    return dir;
  }
  await mkdir(path.dirname(dir), { recursive: true });
  const tmp = await mkdtemp(`${dir}.tmp-`);
  try {
    await git(['clone', '--quiet', '--mirror', '--', url, tmp]);
    await rm(dir, { recursive: true, force: true });
    const { rename } = await import('node:fs/promises');
    await rename(tmp, dir);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

export async function hasCommit(gitDir: string, commit: string): Promise<boolean> {
  try {
    await git(['--git-dir', gitDir, 'cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a reference (branch, tag, SHA) to a 40-character commit in the mirror. */
export async function revParse(gitDir: string, ref: string): Promise<string | undefined> {
  for (const candidate of [`refs/tags/${ref}`, `refs/heads/${ref}`, ref]) {
    try {
      const out = (
        await git(['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
      ).trim();
      if (/^[0-9a-f]{40}$/.test(out)) return out;
    } catch {
      // essai suivant
    }
  }
  return undefined;
}

/**
 * Extracts the tree of a commit into `destDir`. No hook is run and
 * symbolic links are written as plain text files.
 */
export async function materialize(gitDir: string, commit: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const indexDir = await mkdtemp(path.join(os.tmpdir(), 'ahub-index-'));
  try {
    await git(['--git-dir', gitDir, '--work-tree', destDir, 'checkout', '-f', commit, '--', '.'], {
      env: { GIT_INDEX_FILE: path.join(indexDir, 'index') },
    });
  } catch (e) {
    // A commit without any file makes "checkout -- ." fail: empty tree, nothing to extract.
    const empty = (await git(['--git-dir', gitDir, 'ls-tree', '--name-only', commit])).trim() === '';
    if (!empty) throw e;
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

/** Reads a batch of blobs with a single `git cat-file --batch` process. */
function readBlobs(gitDir: string, oids: string[]): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const result = new Map<string, Buffer>();
    if (oids.length === 0) return resolve(result);
    const child = spawn('git', [...SAFE_CONFIG, '--git-dir', gitDir, 'cat-file', '--batch'], {
      env: gitEnv(),
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (e) => reject(new AhubError('GIT_FAILED', t('git cat-file failed: {0}', [e.message]))));
    child.on('close', (code) => {
      if (code !== 0)
        return reject(new AhubError('GIT_FAILED', t('git cat-file exited with code {0}', [code])));
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const oid of oids) {
        const nl = buf.indexOf(10, pos);
        if (nl === -1) return reject(new AhubError('GIT_FAILED', t('truncated git cat-file output')));
        const header = buf.subarray(pos, nl).toString('utf8').split(' ');
        if (header[1] === 'missing')
          return reject(new AhubError('GIT_FAILED', t('missing git object: {0}', [oid])));
        const size = Number(header[2]);
        result.set(oid, buf.subarray(nl + 1, nl + 1 + size));
        pos = nl + 1 + size + 1;
      }
      resolve(result);
    });
    child.stdin.end(oids.join('\n') + '\n');
  });
}

interface RawTreeNode {
  mode: string;
  type: string;
  oid: string;
  children?: Map<string, RawTreeNode>;
}

/**
 * Computes `tree_sha256` (spec §5.6.4, req-lk-015) for the full tree of a commit.
 * Submodules (mode 160000, outside the spec) are hashed on the identifier of their commit.
 */
export async function treeSha256(gitDir: string, commit: string): Promise<string> {
  const out = await git(['--git-dir', gitDir, 'ls-tree', '-r', '-t', '-z', '--full-tree', commit]);
  const root: RawTreeNode = { mode: '040000', type: 'tree', oid: '', children: new Map() };
  const blobOids = new Set<string>();
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ') as [string, string, string];
    const parts = record.slice(tab + 1).split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.children!.get(parts[i]!);
      if (!next) {
        next = { mode: '040000', type: 'tree', oid: '', children: new Map() };
        node.children!.set(parts[i]!, next);
      }
      node = next;
    }
    const name = parts[parts.length - 1]!;
    if (type === 'tree') {
      const existing = node.children!.get(name);
      node.children!.set(name, { mode, type, oid, children: existing?.children ?? new Map() });
    } else {
      node.children!.set(name, { mode, type, oid });
      if (type === 'blob') blobOids.add(oid);
    }
  }
  const blobs = await readBlobs(gitDir, [...blobOids]);
  const hashNode = (node: RawTreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children!) {
      let sha: string;
      if (child.type === 'tree') sha = hashNode(child);
      else if (child.type === 'blob') sha = sha256Hex(blobs.get(child.oid)!);
      else sha = sha256Hex(child.oid);
      entries.push({ mode: child.mode, name, sha256: sha });
    }
    return canonicalTreeHash(entries);
  };
  return hashNode(root);
}
