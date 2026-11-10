import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  jsonIsEffectivelyEmpty,
  mergeJson,
  mergeToml,
  type MergedEntryRecord,
  unmergeJson,
  unmergeToml,
} from '../src/index.js';

const server: MergedEntryRecord = {
  type: 'key',
  keyPath: ['mcpServers', 'demo'],
  value: { command: 'npx', args: ['-y', 'demo'] },
};
const hook: MergedEntryRecord = {
  type: 'append',
  keyPath: ['hooks', 'PreToolUse'],
  value: { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a' }] },
};

describe('fusion JSON', () => {
  it('crée le document quand il n’existe pas', () => {
    const r = mergeJson(undefined, [server]);
    expect(JSON.parse(r.text)).toEqual({ mcpServers: { demo: server.value } });
    expect(r.owned).toEqual([server]);
    expect(r.conflicts).toEqual([]);
  });

  it('préserve le contenu et les commentaires existants', () => {
    const existing =
      '{\n  // serveurs de l’équipe\n  "mcpServers": {\n    "autre": { "command": "x" }\n  },\n  "theme": "dark"\n}\n';
    const r = mergeJson(existing, [server]);
    expect(r.text).toContain('// serveurs de l’équipe');
    expect(r.text).toContain('"theme": "dark"');
    expect(r.text).toContain('"autre"');
    expect(r.text).toContain('"demo"');
    // Commentaires et contenu sont conservés ; l'indentation voisine de l'édition peut être normalisée.
    const back = unmergeJson(r.text, r.owned);
    expect(back.text).toContain('// serveurs de l’équipe');
    expect(parseJsonc(back.text)).toEqual(parseJsonc(existing));
  });

  it('n’écrase jamais une clé existante de valeur différente', () => {
    const existing = '{"mcpServers":{"demo":{"command":"autre"}}}';
    const r = mergeJson(existing, [server]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.reason).toBe('foreign');
    expect(r.owned).toEqual([]);
    expect(JSON.parse(r.text).mcpServers.demo.command).toBe('autre');
  });

  it('adopte une valeur identique déjà présente', () => {
    const r = mergeJson(JSON.stringify({ mcpServers: { demo: server.value } }), [server]);
    expect(r.conflicts).toEqual([]);
    expect(r.owned).toEqual([server]);
  });

  it('ajoute aux listes sans doublon et retire seulement son élément', () => {
    const existing = JSON.stringify(
      { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo perso' }] }] } },
      null,
      2,
    );
    const once = mergeJson(existing, [hook]);
    const twice = mergeJson(once.text, [hook]);
    expect(JSON.parse(twice.text).hooks.PreToolUse).toHaveLength(2);
    const back = unmergeJson(twice.text, [hook]);
    expect(JSON.parse(back.text).hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'echo perso' }] },
    ]);
  });

  it('élague les conteneurs devenus vides au retrait', () => {
    const r = mergeJson(undefined, [server, hook]);
    const back = unmergeJson(r.text, r.owned);
    expect(JSON.parse(back.text)).toEqual({});
  });

  it('laisse en place une entrée modifiée à la main', () => {
    const r = mergeJson(undefined, [server]);
    const edited = r.text.replace('"npx"', '"node"');
    const back = unmergeJson(edited, r.owned);
    expect(back.kept).toEqual([server]);
    expect(JSON.parse(back.text).mcpServers.demo.command).toBe('node');
  });

  it('pose les clés « ensure » sans les retirer', () => {
    const ensure: MergedEntryRecord = { type: 'ensure', keyPath: ['version'], value: 1 };
    const r = mergeJson(undefined, [ensure, hook]);
    expect(JSON.parse(r.text).version).toBe(1);
    const back = unmergeJson(r.text, r.owned);
    expect(JSON.parse(back.text)).toEqual({ version: 1 });
    expect(jsonIsEffectivelyEmpty(back.text, [ensure])).toBe(true);
    expect(jsonIsEffectivelyEmpty('{"version":1,"autre":2}', [ensure])).toBe(false);
  });

  it('laisse intact un fichier illisible', () => {
    const r = mergeJson('{ pas du json', [server]);
    expect(r.text).toBe('{ pas du json');
    expect(r.conflicts[0]!.reason).toBe('unreadable');
  });
});

describe('fusion TOML (bloc délimité)', () => {
  const entry: MergedEntryRecord = {
    type: 'block',
    keyPath: ['mcp_servers', 'demo'],
    value: { command: 'npx', args: ['-y', 'demo'], env: { A: '1' } },
  };

  it('ajoute un bloc sans réécrire le reste du fichier', () => {
    const existing = '# ma config\nmodel = "gpt-5"\n\n[mcp_servers.autre]\ncommand = "x"\n';
    const r = mergeToml(existing, 'github.com/acme/demo', [entry], []);
    expect(r.text.startsWith(existing.trimEnd())).toBe(true);
    const parsed = parseToml(r.text) as any;
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.mcp_servers.autre.command).toBe('x');
    expect(parsed.mcp_servers.demo).toEqual(entry.value);
    const back = unmergeToml(r.text, 'github.com/acme/demo', r.owned);
    expect(back.text).toBe(existing);
  });

  it('refuse d’écraser une table existante hors bloc', () => {
    const r = mergeToml('[mcp_servers.demo]\ncommand = "autre"\n', 'id', [entry], []);
    expect(r.conflicts[0]!.reason).toBe('foreign');
    expect(r.owned).toEqual([]);
  });

  it('remplace son propre bloc à la mise à jour', () => {
    const first = mergeToml(undefined, 'id', [entry], []);
    const next: MergedEntryRecord = { ...entry, value: { command: 'node', args: [] } };
    const second = mergeToml(first.text, 'id', [next], first.owned);
    expect((parseToml(second.text) as any).mcp_servers.demo).toEqual(next.value);
    expect(second.text.match(/>>> ahub/g)).toHaveLength(1);
  });

  it('détecte un bloc modifié à la main', () => {
    const first = mergeToml(undefined, 'id', [entry], []);
    const edited = first.text.replace('"npx"', '"node"');
    expect(mergeToml(edited, 'id', [entry], first.owned).conflicts[0]!.reason).toBe('modified');
    expect(unmergeToml(edited, 'id', first.owned).kept).toHaveLength(1);
  });

  it('supprime tout quand le fichier ne contenait que le bloc', () => {
    const first = mergeToml(undefined, 'id', [entry], []);
    expect(unmergeToml(first.text, 'id', first.owned).text).toBe('');
  });
});
