import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createContext, git, type ProjectContext } from '../src/index.js';

const require = createRequire(import.meta.url);
const created: string[] = [];

export async function tmpDir(prefix = 'ahub-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function cleanupTmp(): Promise<void> {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export async function writeTree(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

const IDENT = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
];

/** Adds a commit (and an optional tag) to a local test git repository. Returns the SHA. */
export async function commit(
  dir: string,
  files: Record<string, string | Buffer>,
  tag?: string,
  annotated = false,
): Promise<string> {
  await writeTree(dir, files);
  await git(['add', '-A'], { cwd: dir });
  await git([...IDENT, 'commit', '-q', '--allow-empty', '-m', tag ?? 'commit'], { cwd: dir });
  if (tag) await git(annotated ? [...IDENT, 'tag', '-a', tag, '-m', tag] : ['tag', tag], { cwd: dir });
  return (await git(['rev-parse', 'HEAD'], { cwd: dir })).trim();
}

export async function gitRepo(
  files: Record<string, string | Buffer>,
  tag?: string,
): Promise<{ dir: string; sha: string }> {
  const dir = await tmpDir('ahub-repo-');
  await git(['init', '-q', '-b', 'main'], { cwd: dir });
  const sha = await commit(dir, files, tag);
  return { dir, sha };
}

/** Isolated project context: home folder, cache and git mirrors of the test's own. */
export async function testContext(
  mirrors: Record<string, string> = {},
  opts: { global?: boolean } = {},
): Promise<ProjectContext> {
  const cwd = await tmpDir('ahub-project-');
  const home = await tmpDir('ahub-home-');
  const cache = await tmpDir('ahub-cache-');
  return createContext({
    cwd,
    ...(opts.global ? { global: true } : {}),
    env: { AHUB_HOME: home, AHUB_CACHE_DIR: cache, AHUB_GIT_MIRRORS: JSON.stringify(mirrors) },
  });
}

/** Recursive list of the files of a folder (relative POSIX paths, sorted). */
export async function listTree(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(dir, child)));
    else out.push(child);
  }
  return out.sort();
}

export function officialSchema(name: string): Record<string, unknown> {
  return require(`../vendor/openapm/${name}`) as Record<string, unknown>;
}

/** Demonstration package covering every primitive. */
export function demoPackage(version = '1.0.0', extra: Record<string, string> = {}): Record<string, string> {
  return {
    'apm.yml': [
      'name: demo-pack',
      `version: ${version}`,
      'description: Paquet de démonstration',
      'license: Apache-2.0',
      'dependencies:',
      '  mcp:',
      '    - name: demo-server',
      '      registry: false',
      '      transport: stdio',
      '      command: npx',
      '      args: ["-y", "@example/demo-mcp"]',
      '      env:',
      '        DEMO_TOKEN: ${DEMO_TOKEN}',
      '',
    ].join('\n'),
    '.apm/skills/hello-skill/SKILL.md': `---\nname: hello-skill\ndescription: Dit bonjour (version ${version}).\n---\n\n# Bonjour\n\nSalue poliment.\n`,
    '.apm/skills/hello-skill/references/notes.md': 'Notes de référence.\n',
    '.apm/agents/reviewer.agent.md':
      '---\ndescription: Relit le code.\nmodel: sonnet\ntools: [read, search]\n---\n\nTu relis le code avec soin.\n',
    '.apm/prompts/summarize.prompt.md':
      '---\ndescription: Résume un fichier.\nargument-hint: <fichier>\n---\n\nRésume le fichier donné.\n',
    '.apm/instructions/style.instructions.md':
      '---\ndescription: Style de code.\napplyTo: "**/*.ts"\n---\n\nUtilise des noms explicites.\n',
    '.apm/hooks/notify.json': JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo avant', timeout: 5 }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'echo fin' }] }],
        },
      },
      null,
      2,
    ),
    ...extra,
  };
}
