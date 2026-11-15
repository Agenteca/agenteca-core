import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ADAPTERS,
  applyDeploy,
  detectTargets,
  type PackageOps,
  prepareDeploy,
  type PriorPackageState,
  readPackage,
  splitFrontmatter,
  type Target,
} from '../src/index.js';
import { cleanupTmp, demoPackage, listTree, tmpDir, writeTree } from './helpers.js';

afterAll(cleanupTmp);

async function demoContent() {
  const dir = await tmpDir('ahub-pkg-');
  await writeTree(dir, demoPackage());
  return readPackage(dir, 'demo-pack');
}

/** Déploie le paquet de démonstration pour une cible, puis le retire entièrement. */
async function deployAndRemove(
  target: Target,
  scope: 'project' | 'user' = 'project',
  seed: Record<string, string> = {},
) {
  const root = await tmpDir(`ahub-${target}-`);
  await writeTree(root, seed);
  const before = await listTree(root);
  const content = await demoContent();
  const res = ADAPTERS[target](content, { scope, packageSlug: 'demo-pack' });
  const ops: PackageOps = {
    identity: 'github.com/acme/demo-pack',
    name: 'demo-pack',
    files: res.files,
    merges: res.merges,
  };

  const install = await prepareDeploy(root, [ops], []);
  expect(install.plan.conflicts).toEqual([]);
  await applyDeploy(install);
  const deployed = await listTree(root);
  const read = (rel: string) => readFile(path.join(root, rel), 'utf8');
  const snapshot: Record<string, string> = {};
  for (const f of deployed) snapshot[f] = await read(f);

  const record = install.records.get(ops.identity)!;
  const prior: PriorPackageState[] = [{ identity: ops.identity, files: record.files, merged: record.merged }];
  const removal = await prepareDeploy(root, [], prior);
  expect(removal.plan.conflicts).toEqual([]);
  await applyDeploy(removal);
  const after = await listTree(root);
  return { res, deployed, snapshot, before, after, root };
}

describe('lecture du paquet', () => {
  it('découvre toutes les primitives d’un paquet APM', async () => {
    const c = await demoContent();
    expect(c.layout).toBe('apm_package');
    expect(c.skills.map((s) => s.name)).toEqual(['hello-skill']);
    expect(c.skills[0]!.files.map((f) => f.relPath)).toEqual(['SKILL.md', 'references/notes.md']);
    expect(c.agents.map((a) => a.name)).toEqual(['reviewer']);
    expect(c.prompts.map((p) => p.name)).toEqual(['summarize']);
    expect(c.instructions.map((i) => i.name)).toEqual(['style']);
    expect(Object.keys(c.hooks[0]!.events)).toEqual(['PreToolUse', 'Stop']);
    expect(c.mcp.map((m) => m.name)).toEqual(['demo-server']);
    expect(c.diagnostics).toEqual([]);
  });

  it('lit un dépôt SKILL.md seul, une collection de skills et un plugin Claude', async () => {
    const bundle = await tmpDir();
    await writeTree(bundle, {
      'SKILL.md': '---\nname: solo\ndescription: Seul.\n---\nCorps\n',
      'scripts/run.sh': '#!/bin/sh\n',
    });
    const b = await readPackage(bundle, 'solo-repo');
    expect(b.layout).toBe('skill_bundle');
    expect(b.skills[0]).toMatchObject({ name: 'solo', sourceDir: '.' });

    const coll = await tmpDir();
    await writeTree(coll, {
      'skills/a/SKILL.md': '---\nname: a\ndescription: A.\n---\n',
      'skills/b/SKILL.md': '---\nname: b\ndescription: B.\n---\n',
    });
    expect((await readPackage(coll, 'coll')).skills.map((s) => s.name)).toEqual(['a', 'b']);

    const plugin = await tmpDir();
    await writeTree(plugin, {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'my-plugin', version: '2.0.0' }),
      'skills/s/SKILL.md': '---\nname: s\ndescription: S.\n---\n',
      'agents/helper.md': '---\nname: helper\ndescription: Aide.\n---\nCorps\n',
      'commands/go.md': 'Fais-le.\n',
      'hooks/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] },
      }),
      '.mcp.json': JSON.stringify({ mcpServers: { p: { command: 'node', args: ['s.js'] } } }),
    });
    const p = await readPackage(plugin, 'x');
    expect(p).toMatchObject({ layout: 'plugin', name: 'my-plugin', version: '2.0.0' });
    expect([p.skills.length, p.agents.length, p.prompts.length, p.hooks.length, p.mcp.length]).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it('ignore les liens symboliques et signale les skills non conformes', async () => {
    const { symlink } = await import('node:fs/promises');
    const dir = await tmpDir();
    await writeTree(dir, { 'skills/Bad_Name/SKILL.md': '---\nname: other\n---\n' });
    await symlink('/etc/passwd', path.join(dir, 'skills', 'Bad_Name', 'leak.txt'));
    const c = await readPackage(dir, 'x');
    expect(c.skills[0]!.files.map((f) => f.relPath)).toEqual(['SKILL.md']);
    const codes = c.diagnostics.map((d) => d.code);
    expect(codes).toContain('SYMLINK_SKIPPED');
    expect(codes).toContain('SKILL_NAME_MISMATCH');
    expect(codes).toContain('SKILL_DESCRIPTION_INVALID');
  });

  it('refuse un dossier sans disposition reconnue', async () => {
    const dir = await tmpDir();
    await writeTree(dir, { 'README.md': 'rien' });
    await expect(readPackage(dir, 'x')).rejects.toThrowError(/no recognised package layout/);
  });
});

describe('adaptateur Claude Code', () => {
  it('déploie puis retire sans laisser de trace', async () => {
    const { deployed, snapshot, after, res } = await deployAndRemove('claude');
    expect(deployed).toEqual([
      '.claude/agents/reviewer.md',
      '.claude/commands/summarize.md',
      '.claude/rules/style.md',
      '.claude/settings.json',
      '.claude/skills/hello-skill/SKILL.md',
      '.claude/skills/hello-skill/references/notes.md',
      '.mcp.json',
    ]);
    const agent = splitFrontmatter(snapshot['.claude/agents/reviewer.md']!, 'a');
    expect(agent.frontmatter).toEqual({
      name: 'reviewer',
      description: 'Relit le code.',
      tools: 'read, search',
      model: 'sonnet',
    });
    expect(agent.body.trim()).toBe('Tu relis le code avec soin.');
    expect(splitFrontmatter(snapshot['.claude/rules/style.md']!, 'r').frontmatter).toEqual({
      paths: ['**/*.ts'],
    });
    expect(JSON.parse(snapshot['.claude/settings.json']!)).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo avant', timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo fin' }] }],
      },
    });
    expect(JSON.parse(snapshot['.mcp.json']!)).toEqual({
      mcpServers: {
        'demo-server': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@example/demo-mcp'],
          env: { DEMO_TOKEN: '${DEMO_TOKEN}' },
        },
      },
    });
    expect(res.diagnostics.map((d) => d.code)).toEqual(['AGENT_CAPABILITY_NOT_PRESERVED']);
    expect(res.executables.map((e) => `${e.kind}:${e.detail}`)).toEqual([
      'hook:PreToolUse',
      'hook:Stop',
      'mcp:stdio',
    ]);
    expect(after).toEqual([]);
  });

  it('préserve une configuration existante, au déploiement comme au retrait', async () => {
    const settings =
      JSON.stringify(
        {
          permissions: { allow: ['Bash(ls:*)'] },
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo perso' }] }] },
        },
        null,
        2,
      ) + '\n';
    const { snapshot, after, root } = await deployAndRemove('claude', 'project', {
      '.claude/settings.json': settings,
      '.claude/agents/mine.md': 'à moi\n',
    });
    const merged = JSON.parse(snapshot['.claude/settings.json']!);
    expect(merged.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(after).toEqual(['.claude/agents/mine.md', '.claude/settings.json']);
    expect(JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8'))).toEqual(
      JSON.parse(settings),
    );
  });

  it('écrit le MCP dans ~/.claude.json en portée utilisateur', async () => {
    const { deployed, after } = await deployAndRemove('claude', 'user');
    expect(deployed).toContain('.claude.json');
    expect(deployed).not.toContain('.mcp.json');
    expect(after).toEqual([]);
  });
});

describe('adaptateur Codex', () => {
  it('déploie puis retire sans laisser de trace', async () => {
    const { deployed, snapshot, after, res } = await deployAndRemove('codex');
    expect(deployed).toEqual([
      '.agents/skills/hello-skill/SKILL.md',
      '.agents/skills/hello-skill/references/notes.md',
      '.agents/skills/summarize/SKILL.md',
      '.codex/agents/reviewer.toml',
      '.codex/config.toml',
      '.codex/hooks.json',
    ]);
    const agent = parseToml(snapshot['.codex/agents/reviewer.toml']!) as Record<string, unknown>;
    expect(agent).toEqual({
      name: 'reviewer',
      description: 'Relit le code.',
      model: 'sonnet',
      developer_instructions: 'Tu relis le code avec soin.\n',
    });
    const config = parseToml(snapshot['.codex/config.toml']!) as any;
    expect(config.mcp_servers['demo-server']).toEqual({
      command: 'npx',
      args: ['-y', '@example/demo-mcp'],
      env_vars: ['DEMO_TOKEN'],
    });
    expect(JSON.parse(snapshot['.codex/hooks.json']!).hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(splitFrontmatter(snapshot['.agents/skills/summarize/SKILL.md']!, 's').frontmatter).toEqual({
      name: 'summarize',
      description: 'Résume un fichier.',
    });
    const codes = res.diagnostics.map((d) => d.code);
    expect(codes).toContain('AGENT_CAPABILITY_NOT_PRESERVED');
    expect(codes).toContain('INSTRUCTION_UNSUPPORTED');
    expect(after).toEqual([]);
  });

  it('préserve un config.toml existant', async () => {
    const existing = 'model = "gpt-5"\n\n[mcp_servers.perso]\ncommand = "x"\n';
    const { snapshot, after, root } = await deployAndRemove('codex', 'project', {
      '.codex/config.toml': existing,
    });
    const merged = parseToml(snapshot['.codex/config.toml']!) as any;
    expect(merged.model).toBe('gpt-5');
    expect(Object.keys(merged.mcp_servers).sort()).toEqual(['demo-server', 'perso']);
    expect(after).toEqual(['.codex/config.toml']);
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).toBe(existing);
  });
});

describe('adaptateur GitHub Copilot', () => {
  it('déploie puis retire sans laisser de trace', async () => {
    const { deployed, snapshot, after, res } = await deployAndRemove('copilot');
    expect(deployed).toEqual([
      '.agents/skills/hello-skill/SKILL.md',
      '.agents/skills/hello-skill/references/notes.md',
      '.github/agents/reviewer.agent.md',
      '.github/hooks/demo-pack-notify.json',
      '.github/instructions/style.instructions.md',
      '.github/mcp.json',
      '.github/prompts/summarize.prompt.md',
      '.vscode/mcp.json',
    ]);
    // Copilot n'a pas de filtre par outil : le hook filtré est ignoré plutôt qu'élargi.
    expect(JSON.parse(snapshot['.github/hooks/demo-pack-notify.json']!)).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: 'echo fin' }] },
    });
    expect(res.diagnostics.map((d) => d.code)).toEqual(['HOOK_MATCHER_UNSUPPORTED']);
    expect(JSON.parse(snapshot['.vscode/mcp.json']!)).toEqual({
      servers: {
        'demo-server': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@example/demo-mcp'],
          env: { DEMO_TOKEN: '${env:DEMO_TOKEN}' },
        },
      },
    });
    expect(JSON.parse(snapshot['.github/mcp.json']!).mcpServers['demo-server']).toMatchObject({
      type: 'local',
      command: 'npx',
      tools: ['*'],
    });
    expect(after).toEqual([]);
  });

  it('utilise ~/.copilot en portée utilisateur', async () => {
    const { deployed, after } = await deployAndRemove('copilot', 'user');
    expect(deployed).toContain('.copilot/agents/reviewer.agent.md');
    expect(deployed).toContain('.copilot/mcp-config.json');
    expect(deployed).not.toContain('.vscode/mcp.json');
    expect(after).toEqual([]);
  });
});

describe('adaptateur Cursor', () => {
  it('déploie puis retire sans laisser de trace', async () => {
    const { deployed, snapshot, after } = await deployAndRemove('cursor');
    expect(deployed).toEqual([
      '.agents/skills/hello-skill/SKILL.md',
      '.agents/skills/hello-skill/references/notes.md',
      '.cursor/agents/reviewer.md',
      '.cursor/commands/summarize.md',
      '.cursor/hooks.json',
      '.cursor/mcp.json',
      '.cursor/rules/style.mdc',
    ]);
    expect(splitFrontmatter(snapshot['.cursor/rules/style.mdc']!, 'r').frontmatter).toEqual({
      description: 'Style de code.',
      globs: '**/*.ts',
      alwaysApply: false,
    });
    expect(JSON.parse(snapshot['.cursor/hooks.json']!)).toEqual({
      version: 1,
      hooks: {
        preToolUse: [{ command: 'echo avant', type: 'command', timeout: 5, matcher: 'Bash' }],
        stop: [{ command: 'echo fin', type: 'command' }],
      },
    });
    expect(JSON.parse(snapshot['.cursor/mcp.json']!).mcpServers['demo-server'].env).toEqual({
      DEMO_TOKEN: '${env:DEMO_TOKEN}',
    });
    expect(after).toEqual([]);
  });

  it('garde les hooks existants et la clé version partagée', async () => {
    const existing =
      JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo perso' }] } }, null, 2) + '\n';
    const { after, root } = await deployAndRemove('cursor', 'project', { '.cursor/hooks.json': existing });
    expect(after).toEqual(['.cursor/hooks.json']);
    expect(JSON.parse(await readFile(path.join(root, '.cursor/hooks.json'), 'utf8'))).toEqual(
      JSON.parse(existing),
    );
  });
});

describe('déploiement multi-cibles', () => {
  it('partage un seul exemplaire des skills entre Codex, Copilot et Cursor', async () => {
    const root = await tmpDir();
    const content = await demoContent();
    const ops: PackageOps = { identity: 'id', name: 'demo-pack', files: [], merges: [] };
    for (const t of ['claude', 'codex', 'copilot', 'cursor'] as Target[]) {
      const r = ADAPTERS[t](content, { scope: 'project', packageSlug: 'demo-pack' });
      ops.files.push(...r.files);
      ops.merges.push(...r.merges);
    }
    const prepared = await prepareDeploy(root, [ops], []);
    const shared = prepared.plan.files.find((f) => f.path === '.agents/skills/hello-skill/SKILL.md')!;
    expect(shared.targets.sort()).toEqual(['codex', 'copilot', 'cursor']);
    await applyDeploy(prepared);
    const record = prepared.records.get('id')!;
    await applyDeploy(
      await prepareDeploy(root, [], [{ identity: 'id', files: record.files, merged: record.merged }]),
    );
    expect(await listTree(root)).toEqual([]);
  });

  it('refuse tout chemin qui sortirait de la racine ou traverserait un lien', async () => {
    const { symlink } = await import('node:fs/promises');
    const root = await tmpDir();
    const outside = await tmpDir();
    const bad = (p: string): PackageOps => ({
      identity: 'id',
      name: 'x',
      files: [{ path: p, bytes: Buffer.from('x'), primitive: 'skill', target: 'claude' }],
      merges: [],
    });
    await expect(prepareDeploy(root, [bad('../evil.md')], [])).rejects.toThrowError(/refused/);
    await expect(prepareDeploy(root, [bad('/etc/evil')], [])).rejects.toThrowError(/refused/);
    await symlink(outside, path.join(root, '.claude'));
    await expect(prepareDeploy(root, [bad('.claude/agents/x.md')], [])).rejects.toThrowError(/symbolic link/);
  });

  it('détecte les outils présents dans un projet', async () => {
    const root = await tmpDir();
    expect(detectTargets(root, 'project')).toEqual([]);
    await writeTree(root, {
      'CLAUDE.md': 'x',
      '.cursor/rules/a.mdc': 'x',
      '.github/copilot-instructions.md': 'x',
    });
    expect(detectTargets(root, 'project')).toEqual(['claude', 'copilot', 'cursor']);
  });
});
