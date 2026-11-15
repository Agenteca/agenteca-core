import { stringify as tomlStringify } from 'smol-toml';
import { withFrontmatter } from '../yaml.js';
import {
  capabilityDiagnostic,
  deployableMcp,
  emptyResult,
  selectedSkills,
  skillFiles,
  text,
  translateHooks,
  unparsedFrontmatterDiagnostic,
} from './common.js';
import type { Adapter } from './types.js';
import { t } from '../i18n.js';

/**
 * OpenAI Codex. Agents en TOML dans `.codex/agents/`, skills dans
 * `.agents/skills/`, hooks dans `.codex/hooks.json`, serveurs MCP dans
 * `.codex/config.toml`. Codex n'a pas de commandes de projet : elles sont
 * converties en skills (écart assumé par rapport à la matrice APM).
 */
export const codexAdapter: Adapter = (content, ctx) => {
  const r = emptyResult();
  const skills = selectedSkills(content, ctx);
  r.files.push(...skillFiles(skills, '.agents/skills', 'codex'));

  for (const a of content.agents) {
    if (a.frontmatterError) r.diagnostics.push(unparsedFrontmatterDiagnostic(a, 'codex'));
    const fm = a.frontmatter ?? {};
    const doc: Record<string, unknown> = {
      name: a.name,
      description: typeof fm.description === 'string' ? fm.description : `Agent ${a.name}`,
    };
    // req-tg-015 : `model` et `model_reasoning_effort` restent des clés TOML de premier niveau.
    if (typeof fm.model === 'string') doc.model = fm.model;
    if (typeof fm.model_reasoning_effort === 'string') doc.model_reasoning_effort = fm.model_reasoning_effort;
    doc.developer_instructions = a.body.trim() + '\n';
    if (fm.tools !== undefined) r.diagnostics.push(capabilityDiagnostic(a, 'codex', ['tools']));
    r.files.push({
      path: `.codex/agents/${a.name}.toml`,
      bytes: text(tomlStringify(doc) + '\n'),
      primitive: 'agent',
      target: 'codex',
    });
  }

  for (const p of content.prompts) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name)) {
      r.diagnostics.push({
        code: 'COMMAND_NAME_UNSUPPORTED',
        message: t('command "{0}" → codex: name is not valid for a skill, skipped', [p.name]),
        path: p.sourcePath,
      });
      continue;
    }
    if (skills.some((s) => s.name === p.name)) {
      r.diagnostics.push({
        code: 'COMMAND_SHADOWED',
        message: t('command "{0}" → codex: a skill with the same name already exists, command skipped', [
          p.name,
        ]),
        path: p.sourcePath,
      });
      continue;
    }
    const description =
      typeof p.frontmatter?.description === 'string' ? p.frontmatter.description : `Commande ${p.name}`;
    r.files.push({
      path: `.agents/skills/${p.name}/SKILL.md`,
      bytes: text(withFrontmatter({ name: p.name, description }, p.body)),
      primitive: 'command',
      target: 'codex',
    });
  }

  for (const i of content.instructions) {
    r.diagnostics.push({
      code: 'INSTRUCTION_UNSUPPORTED',
      message: t(
        'instruction "{0}" → codex: Codex does not read per-file instructions (only AGENTS.md); not deployed.',
        [i.name],
      ),
      path: i.sourcePath,
    });
  }

  const th = translateHooks(content.hooks, 'codex', { supportsMatcher: true });
  r.diagnostics.push(...th.diagnostics);
  r.executables.push(...th.executables);
  if (th.hooks.length > 0) {
    r.merges.push({
      path: '.codex/hooks.json',
      format: 'json',
      kind: 'hooks',
      target: 'codex',
      entries: th.hooks.map((h) => {
        const handler: Record<string, unknown> = { type: 'command', command: h.command };
        if (h.timeout !== undefined) handler.timeout = h.timeout;
        const group: Record<string, unknown> = h.matcher
          ? { matcher: h.matcher, hooks: [handler] }
          : { hooks: [handler] };
        return { type: 'append' as const, keyPath: ['hooks', h.event], value: group };
      }),
    });
  }

  const mcp = deployableMcp(content.mcp, 'codex');
  r.diagnostics.push(...mcp.diagnostics);
  r.executables.push(...mcp.executables);
  const entries = [];
  for (const m of mcp.servers) {
    const value: Record<string, unknown> = {};
    if (m.transport === 'stdio') {
      value.command = m.command!;
      value.args = m.args ?? [];
      // config.toml ne développe pas les variables : une référence pure `${VAR}` devient `env_vars`.
      const env: Record<string, string> = {};
      const envVars: string[] = [];
      for (const [k, v] of Object.entries(m.env ?? {})) {
        const pure = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
        if (pure && pure[1] === k) envVars.push(k);
        else {
          if (v.includes('${')) {
            r.diagnostics.push({
              code: 'MCP_VAR_UNSUPPORTED',
              message: t(
                'MCP server "{0}" → codex: the variable in "{1}" is not expanded by Codex, value passed as is.',
                [m.name, k],
              ),
            });
          }
          env[k] = v;
        }
      }
      if (Object.keys(env).length > 0) value.env = env;
      if (envVars.length > 0) value.env_vars = envVars;
    } else if (m.transport === 'sse') {
      r.diagnostics.push({
        code: 'MCP_TRANSPORT_UNSUPPORTED',
        message: t('MCP server "{0}" → codex: the SSE transport is not supported by Codex, server skipped.', [
          m.name,
        ]),
      });
      continue;
    } else {
      value.url = m.url!;
      if (m.headers && Object.keys(m.headers).length > 0) value.http_headers = m.headers;
    }
    entries.push({ type: 'block' as const, keyPath: ['mcp_servers', m.name], value });
  }
  if (entries.length > 0)
    r.merges.push({ path: '.codex/config.toml', format: 'toml', kind: 'mcp', target: 'codex', entries });
  return r;
};
