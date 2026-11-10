import {
  convertVarMap,
  convertVars,
  deployableMcp,
  emptyResult,
  selectedSkills,
  skillFiles,
  text,
  translateHooks,
} from './common.js';
import type { Adapter } from './types.js';

/**
 * GitHub Copilot (VS Code, CLI). Agents `.github/agents/*.agent.md`, skills
 * `.agents/skills/` (ou `.github/skills/` avec l'option de chemins natifs),
 * prompts `.github/prompts/` (VS Code seulement), hooks `.github/hooks/*.json`,
 * MCP dans `.vscode/mcp.json` (clé `servers`) et `.github/mcp.json` (CLI, clé `mcpServers`).
 */
export const copilotAdapter: Adapter = (content, ctx) => {
  const r = emptyResult();
  const user = ctx.scope === 'user';
  const root = user ? '.copilot' : '.github';
  const skillsDir = ctx.legacySkillPaths ? (user ? '.copilot/skills' : '.github/skills') : '.agents/skills';
  r.files.push(...skillFiles(selectedSkills(content, ctx), skillsDir, 'copilot'));

  // Le format `.agent.md` est natif : le fichier source est copié tel quel.
  for (const a of content.agents) {
    r.files.push({
      path: `${root}/agents/${a.name}.agent.md`,
      bytes: a.raw,
      primitive: 'agent',
      target: 'copilot',
    });
  }
  for (const p of content.prompts) {
    r.files.push({
      path: `${root}/prompts/${p.name}.prompt.md`,
      bytes: p.raw,
      primitive: 'command',
      target: 'copilot',
    });
  }
  for (const i of content.instructions) {
    r.files.push({
      path: `${root}/instructions/${i.name}.instructions.md`,
      bytes: i.raw,
      primitive: 'instruction',
      target: 'copilot',
    });
  }

  const th = translateHooks(content.hooks, 'copilot', { supportsMatcher: false });
  r.diagnostics.push(...th.diagnostics);
  r.executables.push(...th.executables);
  const byHook = new Map<string, Record<string, unknown[]>>();
  for (const h of th.hooks) {
    const events = byHook.get(h.hookName) ?? {};
    const handler: Record<string, unknown> = { type: 'command', bash: h.command };
    if (h.timeout !== undefined) handler.timeoutSec = h.timeout;
    (events[h.event] ??= []).push(handler);
    byHook.set(h.hookName, events);
  }
  for (const [name, events] of byHook) {
    r.files.push({
      path: `${root}/hooks/${ctx.packageSlug}-${name}.json`,
      bytes: text(JSON.stringify({ version: 1, hooks: events }, null, 2) + '\n'),
      primitive: 'hook',
      target: 'copilot',
    });
  }

  const mcp = deployableMcp(content.mcp, 'copilot');
  r.diagnostics.push(...mcp.diagnostics);
  r.executables.push(...mcp.executables);
  if (mcp.servers.length > 0) {
    // Copilot CLI (et agent cloud) : clé `mcpServers`, type `local` pour stdio.
    r.merges.push({
      path: user ? '.copilot/mcp-config.json' : '.github/mcp.json',
      format: 'json',
      kind: 'mcp',
      target: 'copilot',
      entries: mcp.servers.map((m) => {
        const value: Record<string, unknown> =
          m.transport === 'stdio'
            ? { type: 'local', command: m.command!, args: m.args ?? [], tools: m.tools ?? ['*'] }
            : { type: m.transport === 'sse' ? 'sse' : 'http', url: m.url!, tools: m.tools ?? ['*'] };
        if (m.transport === 'stdio' && m.env && Object.keys(m.env).length > 0) value.env = m.env;
        if (m.transport !== 'stdio' && m.headers && Object.keys(m.headers).length > 0)
          value.headers = m.headers;
        return { type: 'key' as const, keyPath: ['mcpServers', m.name], value };
      }),
    });
    // VS Code : `.vscode/mcp.json`, clé `servers`. Pas d'équivalent fichier en portée utilisateur.
    if (!user) {
      r.merges.push({
        path: '.vscode/mcp.json',
        format: 'json',
        kind: 'mcp',
        target: 'copilot',
        entries: mcp.servers.map((m) => {
          const value: Record<string, unknown> = {};
          if (m.transport === 'stdio') {
            value.type = 'stdio';
            value.command = convertVars(m.command!, 'env-prefixed');
            value.args = (m.args ?? []).map((a) => convertVars(a, 'env-prefixed'));
            const env = convertVarMap(m.env, 'env-prefixed');
            if (env) value.env = env;
          } else {
            value.type = m.transport === 'sse' ? 'sse' : 'http';
            value.url = convertVars(m.url!, 'env-prefixed');
            const headers = convertVarMap(m.headers, 'env-prefixed');
            if (headers) value.headers = headers;
          }
          return { type: 'key' as const, keyPath: ['servers', m.name], value };
        }),
      });
    }
  }
  return r;
};
