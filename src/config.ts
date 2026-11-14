import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AhubError } from './errors.js';

/**
 * Configuration propre à ahub (liste des registres). Aucun standard ne couvre
 * ce besoin : exception documentée, fichier `~/.config/ahub/config.json` (XDG).
 */
export interface RegistryConfig {
  name: string;
  url: string;
  /** `server` : API Agenteca ; `git` : dépôt publiant un marketplace.json ; `path` : dossier local. */
  kind: 'server' | 'git' | 'path';
}

export interface AhubConfig {
  registries: RegistryConfig[];
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AHUB_CONFIG) return env.AHUB_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(env.AHUB_HOME || os.homedir(), '.config');
  return path.join(base, 'ahub', 'config.json');
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AhubConfig> {
  const file = configPath(env);
  if (!existsSync(file)) return { registries: [] };
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Partial<AhubConfig>;
    return { registries: Array.isArray(data.registries) ? data.registries : [] };
  } catch {
    throw new AhubError('USAGE', `configuration illisible : ${file}`);
  }
}

export async function saveConfig(config: AhubConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + '\n');
}

/** Déduit le type de registre d'une URL ou d'un chemin. */
export function inferRegistryKind(url: string): RegistryConfig['kind'] {
  if (/^(\.{1,2}(\/|$)|\/|~\/)/.test(url)) return 'path';
  if (
    /^https?:\/\//.test(url) &&
    !/\.git$/.test(url) &&
    !/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(url)
  )
    return 'server';
  return 'git';
}

export function registryNameFromUrl(url: string): string {
  const cleaned = url
    .replace(/\.git$/, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '');
  const last = cleaned.split(/[/:]/).filter(Boolean).pop() ?? 'registre';
  return (
    last
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'registre'
  );
}
