import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Target } from '../manifest.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { cursorAdapter } from './cursor.js';
import type { Adapter, Scope } from './types.js';

export * from './types.js';

export const ADAPTERS: Record<Target, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
  cursor: cursorAdapter,
};

/** Signaux de détection des cibles (matrice des cibles OpenAPM, spec §8.4). */
const PROJECT_SIGNALS: Record<Target, string[]> = {
  claude: ['.claude', 'CLAUDE.md'],
  codex: ['.codex'],
  copilot: [
    '.github/copilot-instructions.md',
    '.github/instructions',
    '.github/agents',
    '.github/prompts',
    '.github/hooks',
  ],
  cursor: ['.cursor', '.cursorrules'],
};

const USER_SIGNALS: Record<Target, string[]> = {
  claude: ['.claude'],
  codex: ['.codex'],
  copilot: ['.copilot'],
  cursor: ['.cursor'],
};

/** Détecte les cibles présentes dans un projet (ou dans le dossier personnel). */
export function detectTargets(root: string, scope: Scope): Target[] {
  const signals = scope === 'user' ? USER_SIGNALS : PROJECT_SIGNALS;
  return (Object.keys(signals) as Target[]).filter((t) =>
    signals[t].some((s) => existsSync(path.join(root, s))),
  );
}
