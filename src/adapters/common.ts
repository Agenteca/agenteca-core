import type { Diagnostic } from '../errors.js';
import type { McpDependency, Target } from '../manifest.js';
import type { HookGroup, HookPrimitive, PackageContent, SkillPrimitive, TextPrimitive } from '../package.js';
import type { AdapterContext, AdapterResult, ExecutableNotice, FileOp } from './types.js';

export function emptyResult(): AdapterResult {
  return { files: [], merges: [], executables: [], diagnostics: [] };
}

export function text(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

/** Skills retenus, en appliquant le sous-ensemble `skills:` éventuel. */
export function selectedSkills(content: PackageContent, ctx: AdapterContext): SkillPrimitive[] {
  if (!ctx.skillSubset || ctx.skillSubset.length === 0) return content.skills;
  return content.skills.filter((s) => ctx.skillSubset!.includes(s.name));
}

export function skillFiles(skills: SkillPrimitive[], baseDir: string, target: Target): FileOp[] {
  const out: FileOp[] = [];
  for (const s of skills) {
    for (const f of s.files) {
      const op: FileOp = {
        path: `${baseDir}/${s.name}/${f.relPath}`,
        bytes: f.bytes,
        primitive: 'skill',
        target,
      };
      if (f.executable) op.executable = true;
      out.push(op);
    }
  }
  return out;
}

export function toolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return undefined;
}

/**
 * Diagnostic exigé par req-tg-006 quand une restriction de capacité déclarée
 * par l'agent source ne peut pas être reproduite à l'identique.
 */
export function capabilityDiagnostic(agent: TextPrimitive, target: Target, dropped: string[]): Diagnostic {
  return {
    code: 'AGENT_CAPABILITY_NOT_PRESERVED',
    message:
      `agent « ${agent.name} » → ${target} : les champs ${dropped.map((d) => `« ${d} »`).join(', ')} ne sont pas reproduits à l’identique ; ` +
      'l’agent généré peut avoir un accès plus large que celui déclaré.',
    path: agent.sourcePath,
  };
}

export function unparsedFrontmatterDiagnostic(agent: TextPrimitive, target: Target): Diagnostic {
  return {
    code: 'AGENT_CAPABILITY_UNVERIFIED',
    message: `agent « ${agent.name} » → ${target} : frontmatter illisible, les restrictions de capacité n’ont pas pu être vérifiées.`,
    path: agent.sourcePath,
  };
}

/** Table des événements de hook : nom canonique (forme Claude) → nom natif par cible. */
const HOOK_EVENTS: Record<string, Record<Target, string | null>> = {
  SessionStart: {
    claude: 'SessionStart',
    codex: 'SessionStart',
    copilot: 'sessionStart',
    cursor: 'sessionStart',
  },
  SessionEnd: { claude: 'SessionEnd', codex: 'SessionEnd', copilot: 'sessionEnd', cursor: 'sessionEnd' },
  UserPromptSubmit: {
    claude: 'UserPromptSubmit',
    codex: 'UserPromptSubmit',
    copilot: 'userPromptSubmitted',
    cursor: 'beforeSubmitPrompt',
  },
  PreToolUse: { claude: 'PreToolUse', codex: 'PreToolUse', copilot: 'preToolUse', cursor: 'preToolUse' },
  PostToolUse: { claude: 'PostToolUse', codex: 'PostToolUse', copilot: 'postToolUse', cursor: 'postToolUse' },
  Stop: { claude: 'Stop', codex: 'Stop', copilot: 'agentStop', cursor: 'stop' },
  SubagentStart: {
    claude: 'SubagentStart',
    codex: 'SubagentStart',
    copilot: 'subagentStart',
    cursor: 'subagentStart',
  },
  SubagentStop: {
    claude: 'SubagentStop',
    codex: 'SubagentStop',
    copilot: 'subagentStop',
    cursor: 'subagentStop',
  },
  PreCompact: { claude: 'PreCompact', codex: 'PreCompact', copilot: 'preCompact', cursor: 'preCompact' },
};

const HOOK_ALIASES: Record<string, string> = {
  sessionstart: 'SessionStart',
  sessionend: 'SessionEnd',
  userpromptsubmit: 'UserPromptSubmit',
  userpromptsubmitted: 'UserPromptSubmit',
  beforesubmitprompt: 'UserPromptSubmit',
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  agentstop: 'Stop',
  subagentstart: 'SubagentStart',
  subagentstop: 'SubagentStop',
  precompact: 'PreCompact',
};

function canonicalEvent(source: string): string | undefined {
  if (source in HOOK_EVENTS) return source;
  if (source === 'stop') return undefined; // « stop » en minuscules n'est natif nulle part sauf Cursor : ambigu, non deviné
  return HOOK_ALIASES[source.toLowerCase()];
}

export interface TranslatedHook {
  hookName: string;
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

/**
 * Traduit les hooks d'un paquet pour une cible. Tout ce qui n'a pas
 * d'équivalent sûr est ignoré avec un diagnostic, jamais deviné.
 */
export function translateHooks(
  hooks: HookPrimitive[],
  target: Target,
  opts: { supportsMatcher: boolean; passUnknownEvents?: boolean },
): { hooks: TranslatedHook[]; diagnostics: Diagnostic[]; executables: ExecutableNotice[] } {
  const out: TranslatedHook[] = [];
  const diagnostics: Diagnostic[] = [];
  const executables: ExecutableNotice[] = [];
  const skip = (h: HookPrimitive, code: string, message: string): void => {
    diagnostics.push({ code, message: `hook « ${h.name} » → ${target} : ${message}`, path: h.sourcePath });
  };
  for (const h of hooks) {
    for (const [sourceEvent, groups] of Object.entries(h.events)) {
      const canonical = canonicalEvent(sourceEvent);
      let event: string | null | undefined = canonical ? HOOK_EVENTS[canonical]![target] : undefined;
      if (!event && opts.passUnknownEvents && /^[A-Z][A-Za-z]+$/.test(sourceEvent)) event = sourceEvent;
      if (!event) {
        skip(h, 'HOOK_EVENT_UNSUPPORTED', `événement « ${sourceEvent} » sans équivalent, ignoré`);
        continue;
      }
      for (const group of groups as HookGroup[]) {
        if (group.matcher && !opts.supportsMatcher) {
          skip(
            h,
            'HOOK_MATCHER_UNSUPPORTED',
            `le filtre « ${group.matcher} » n’existe pas sur cette cible ; hook ignoré pour ne pas l’élargir à tous les outils`,
          );
          continue;
        }
        for (const handler of group.hooks) {
          const type = handler.type ?? 'command';
          if (type !== 'command' || typeof handler.command !== 'string' || !handler.command.trim()) {
            skip(
              h,
              'HOOK_TYPE_UNSUPPORTED',
              `gestionnaire de type « ${String(type)} » non pris en charge, ignoré`,
            );
            continue;
          }
          const command = handler.command;
          if (/\$\{?[A-Z_]*PLUGIN_ROOT\}?/.test(command) || /(^|\s|["'])\.\.?\//.test(command)) {
            skip(
              h,
              'HOOK_SCRIPT_BUNDLE_UNSUPPORTED',
              'la commande référence un script du paquet ; le déploiement de scripts de hook n’est pas pris en charge en v0.1, hook ignoré',
            );
            continue;
          }
          const t: TranslatedHook = { hookName: h.name, event, command };
          if (group.matcher) t.matcher = group.matcher;
          if (typeof handler.timeout === 'number') t.timeout = handler.timeout;
          out.push(t);
          executables.push({ kind: 'hook', target, name: h.name, detail: event, command });
        }
      }
    }
  }
  return { hooks: out, diagnostics, executables };
}

export type VarStyle = 'plain' | 'env-prefixed';

/** Convertit les références de variables `${VAR}` / `${env:VAR}` vers le style de la cible. */
export function convertVars(value: string, style: VarStyle): string {
  if (style === 'plain') return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '${env:$1}');
}

export function convertVarMap(
  map: Record<string, string> | undefined,
  style: VarStyle,
): Record<string, string> | undefined {
  if (!map || Object.keys(map).length === 0) return undefined;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, convertVars(v, style)]));
}

/** Serveurs MCP déployables : seuls les serveurs auto-définis le sont en v0.1. */
export function deployableMcp(
  mcp: McpDependency[],
  target: Target,
): { servers: McpDependency[]; diagnostics: Diagnostic[]; executables: ExecutableNotice[] } {
  const servers: McpDependency[] = [];
  const diagnostics: Diagnostic[] = [];
  const executables: ExecutableNotice[] = [];
  for (const m of mcp) {
    if (m.registry !== false) {
      diagnostics.push({
        code: 'MCP_REGISTRY_UNSUPPORTED',
        message: `serveur MCP « ${m.name} » → ${target} : la résolution par registre MCP n’est pas prise en charge en v0.1 ; déclarez-le avec « registry: false ».`,
      });
      continue;
    }
    const usesInput = [
      m.command,
      m.url,
      ...(m.args ?? []),
      ...Object.values(m.env ?? {}),
      ...Object.values(m.headers ?? {}),
    ].some((v) => typeof v === 'string' && v.includes('${input:'));
    if (usesInput && target !== 'copilot') {
      diagnostics.push({
        code: 'MCP_INPUT_UNSUPPORTED',
        message: `serveur MCP « ${m.name} » → ${target} : les variables \${input:…} n’existent que dans VS Code ; valeur transmise telle quelle.`,
      });
    }
    servers.push(m);
    executables.push({
      kind: 'mcp',
      target,
      name: m.name,
      detail: m.transport ?? 'stdio',
      command: m.transport === 'stdio' ? [m.command, ...(m.args ?? [])].join(' ') : (m.url ?? ''),
    });
  }
  return { servers, diagnostics, executables };
}

export function isRemote(m: McpDependency): boolean {
  return m.transport !== 'stdio';
}
