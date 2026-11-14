import { describe, expect, it } from 'vitest';
import {
  catalogFromManifestBlock,
  exportMarketplace,
  inferRegistryKind,
  MARKETPLACE_PATHS,
  parseMarketplace,
  registryNameFromUrl,
} from '../src/index.js';

describe('marketplaces natifs', () => {
  it('lit un marketplace au format Claude Code / Copilot CLI', () => {
    const { catalog, diagnostics } = parseMarketplace(
      {
        name: 'acme-tools',
        owner: { name: 'Acme' },
        metadata: { pluginRoot: './plugins' },
        plugins: [
          {
            name: 'review',
            source: './plugins/review',
            description: 'Relecture',
            version: '1.0.0',
            keywords: ['qualité'],
          },
          { name: 'bare', source: 'bare' },
          { name: 'gh', source: { source: 'github', repo: 'acme/gh-plugin', ref: 'v2.0.0' } },
          {
            name: 'sub',
            source: {
              source: 'git-subdir',
              url: 'https://gitlab.com/acme/mono.git',
              path: 'tools/sub',
              sha: 'a'.repeat(40),
            },
          },
          { name: 'npm', source: { source: 'npm', package: '@acme/x' } },
        ],
      },
      { baseRepo: 'acme/marketplace', baseRef: 'main' },
    );
    expect(catalog.name).toBe('acme-tools');
    expect(catalog.entries.map((e) => e.source)).toEqual([
      'acme/marketplace/plugins/review#main',
      'acme/marketplace/plugins/bare#main',
      'acme/gh-plugin#v2.0.0',
      `https://gitlab.com/acme/mono/tools/sub#${'a'.repeat(40)}`,
    ]);
    expect(catalog.entries[0]).toMatchObject({
      description: 'Relecture',
      tags: ['qualité'],
      nativePlugin: true,
    });
    expect(diagnostics.map((d) => d.code)).toEqual(['MARKETPLACE_SOURCE_UNSUPPORTED']);
  });

  it('lit le format Codex (interface.displayName, source local)', () => {
    const { catalog } = parseMarketplace(
      {
        name: 'codex-mkt',
        interface: { displayName: 'Mon catalogue' },
        plugins: [
          { name: 'p', source: { source: 'local', path: './p' }, policy: { installation: 'AVAILABLE' } },
        ],
      },
      { baseDir: '/srv/mkt' },
    );
    expect(catalog.entries[0]!.source).toBe('/srv/mkt/p');
  });

  it('refuse les sources relatives qui remontent hors du dépôt', () => {
    const { catalog } = parseMarketplace(
      { name: 'm', plugins: [{ name: 'x', source: './../../etc' }] },
      { baseRepo: 'a/b' },
    );
    expect(catalog.entries).toEqual([]);
  });

  const catalog = catalogFromManifestBlock(
    {
      owner: { name: 'Agenteca', url: 'https://github.com/agenteca' },
      packages: [
        {
          name: 'hello-agent',
          source: 'agenteca/agenteca-registry/examples/hello-agent',
          version: 'v0.1.0',
          description: 'Exemple',
          tags: ['exemple'],
          nativePlugin: true,
        },
        { name: 'gitlab-pack', source: 'gitlab.com/acme/pack', nativePlugin: true },
        { name: 'apm-only', source: 'acme/apm-only' },
      ],
    },
    'agenteca',
  );

  it('lit le bloc marketplace: d’un apm.yml', () => {
    expect(catalog.entries[0]).toMatchObject({
      name: 'hello-agent',
      source: 'agenteca/agenteca-registry/examples/hello-agent#v0.1.0',
    });
    expect(catalog.owner).toEqual({ name: 'Agenteca', url: 'https://github.com/agenteca' });
  });

  it('exporte au format Claude Code, en n’incluant que les plugins natifs', () => {
    const out = exportMarketplace(catalog, 'claude');
    expect(out.path).toBe(MARKETPLACE_PATHS.claude);
    expect(out.json).toMatchObject({ name: 'agenteca', owner: { name: 'Agenteca' } });
    const plugins = out.json.plugins as Array<Record<string, any>>;
    expect(plugins.map((p) => p.name)).toEqual(['hello-agent', 'gitlab-pack']);
    expect(plugins[0]!.source).toEqual({
      source: 'git-subdir',
      url: 'https://github.com/agenteca/agenteca-registry.git',
      path: 'examples/hello-agent',
      ref: 'v0.1.0',
    });
    expect(plugins[1]!.source).toEqual({ source: 'url', url: 'https://gitlab.com/acme/pack.git' });
    expect(out.diagnostics.map((d) => d.code)).toEqual(['EXPORT_NOT_NATIVE_PLUGIN']);
  });

  it('exporte aux formats Copilot et Codex', () => {
    const copilot = exportMarketplace(catalog, 'copilot').json.plugins as Array<Record<string, any>>;
    expect(copilot[0]!.source).toEqual({
      source: 'github',
      repo: 'agenteca/agenteca-registry',
      path: 'examples/hello-agent',
      ref: 'v0.1.0',
    });
    const codex = exportMarketplace(catalog, 'codex', { includeAll: true });
    expect(codex.path).toBe('.agents/plugins/marketplace.json');
    expect(codex.json.owner).toBeUndefined();
    expect((codex.json.plugins as Array<Record<string, any>>)[2]).toMatchObject({
      name: 'apm-only',
      policy: { installation: 'AVAILABLE' },
      source: { source: 'url' },
    });
  });

  it('n’exporte un plugin natif que vers son propre outil', () => {
    const perTool = catalogFromManifestBlock(
      {
        packages: [
          { name: 'pour-claude', source: 'acme/claude-plugin', nativePlugin: true, tools: ['claude'] },
          { name: 'pour-codex', source: 'acme/codex-plugin', nativePlugin: true, tools: ['codex'] },
          { name: 'partout', source: 'acme/any', nativePlugin: true },
        ],
      },
      'x',
    );
    const names = (f: 'claude' | 'codex' | 'copilot') =>
      (exportMarketplace(perTool, f).json.plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names('claude')).toEqual(['pour-claude', 'partout']);
    expect(names('codex')).toEqual(['pour-codex', 'partout']);
    expect(names('copilot')).toEqual(['partout']);
  });

  it('déduit le type et le nom d’un registre', () => {
    for (const p of ['.', '..', './cat', '../cat', '/srv/cat', '~/cat'])
      expect(inferRegistryKind(p), p).toBe('path');
    for (const g of [
      'acme/catalog',
      'https://github.com/acme/catalog',
      'git@github.com:acme/catalog.git',
      'https://git.example.org/a/b.git',
    ])
      expect(inferRegistryKind(g), g).toBe('git');
    expect(inferRegistryKind('https://catalogue.exemple.org')).toBe('server');
    expect(inferRegistryKind('http://localhost:8080')).toBe('server');
    expect(registryNameFromUrl('https://github.com/acme/Mon_Catalogue.git')).toBe('mon-catalogue');
  });

  it('fait l’aller-retour export Claude → lecture', () => {
    const out = exportMarketplace(catalog, 'claude');
    const { catalog: back } = parseMarketplace(out.json);
    expect(back.entries.map((e) => e.source)).toEqual([
      'https://github.com/agenteca/agenteca-registry/examples/hello-agent#v0.1.0',
      'https://gitlab.com/acme/pack',
    ]);
  });
});
