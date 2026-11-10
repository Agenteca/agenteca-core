# @agenteca/core

Bibliothèque TypeScript d'Agenteca : elle lit des paquets d'agents IA dans des dépôts git et les déploie dans Claude Code, Codex, GitHub Copilot et Cursor.

Elle implémente le format **OpenAPM v0.1** (`apm.yml`, `apm.lock.yaml`) sans dépendre de l'outil `apm`. La CLI `ahub`, le serveur et les extensions s'appuient tous sur elle.

> État : 0.1.0, non publiée sur npm. OpenAPM est lui-même un brouillon de travail (0.x) : le format peut changer.

## Ce qu'elle fait

| Domaine | Module | Standard suivi |
|---|---|---|
| Manifeste | `manifest.ts`, `depref.ts` | OpenAPM §4 |
| Lockfile et empreintes | `lockfile.ts`, `hash.ts` | OpenAPM §5 |
| Résolution des versions | `resolver.ts`, `git.ts` | OpenAPM §7, SemVer (dialecte node-semver) |
| Lecture des paquets | `package.ts` | OpenAPM §8.1, Agent Skills |
| Adaptateurs par outil | `adapters/` | Matrice des cibles OpenAPM, docs de chaque outil |
| Déploiement et retrait | `deploy.ts`, `merge.ts` | — |
| Scan de sécurité | `scan.ts` | SARIF 2.1.0 |
| Marketplaces et registres | `marketplace.ts`, `registry.ts` | Formats natifs Claude Code, Codex, Copilot CLI, Cursor |

Le détail de la conformité, exigence par exigence, est dans [CONFORMANCE.md](CONFORMANCE.md).

## Utilisation

```ts
import { applyInstall, createContext, parseDepString, prepareInstall } from '@agenteca/core';

const ctx = createContext({ cwd: process.cwd() });

// 1. Préparer : résolution, lecture, scan, plan. Rien n'est écrit.
const prepared = await prepareInstall(ctx, {
  add: [parseDepString('acme/code-review#^1.0.0')],
  targets: ['claude', 'cursor'],
  initName: 'mon-projet',
});
console.log(prepared.plan.files, prepared.executables, prepared.findings);

// 2. Appliquer, après accord de l'utilisateur.
await applyInstall(prepared);
```

`prepareInstall` couvre aussi le rejeu du lockfile (`{ frozen: true }`), la mise à jour (`{ update: 'all' }`) et le retrait (`{ remove: ['code-review'] }`).

## Où vont les fichiers

Portée projet. En portée utilisateur, les mêmes dossiers sous `~` (`~/.copilot/` pour Copilot, `~/.claude.json` pour le MCP de Claude Code).

| Outil | Agents | Skills | Commandes | Instructions | Hooks | MCP |
|---|---|---|---|---|---|---|
| Claude Code | `.claude/agents/*.md` | `.claude/skills/` | `.claude/commands/*.md` | `.claude/rules/*.md` | `.claude/settings.json` | `.mcp.json` |
| Codex | `.codex/agents/*.toml` | `.agents/skills/` | converties en skills | non déployées | `.codex/hooks.json` | `.codex/config.toml` |
| Copilot | `.github/agents/*.agent.md` | `.agents/skills/` | `.github/prompts/*.prompt.md` | `.github/instructions/` | `.github/hooks/*.json` | `.vscode/mcp.json` + `.github/mcp.json` |
| Cursor | `.cursor/agents/*.md` | `.agents/skills/` | `.cursor/commands/*.md` | `.cursor/rules/*.mdc` | `.cursor/hooks.json` | `.cursor/mcp.json` |

Chemins vérifiés dans la documentation officielle de chaque outil le 10 novembre 2026.

## Sécurité

Un agent est du texte exécuté par un modèle : il est traité comme du code.

- **Scan avant tout déploiement.** Un constat critique (Unicode caché, téléchargement exécuté) bloque l'installation ; le contournement est explicite (`allowUnsafe`).
- **Aucun script exécuté.** `scripts:` et `lifecycle:` des paquets sont ignorés. Git est appelé sans hooks, sans invite, liens symboliques neutralisés.
- **Rien n'est écrasé en silence.** Un fichier modifié à la main, ou existant sans être géré, bloque l'opération tant que l'utilisateur n'a pas donné son accord pour ce fichier.
- **Fichiers de configuration partagés** (`settings.json`, `.mcp.json`, `config.toml`…) : seules les entrées du paquet sont ajoutées puis retirées ; le reste du fichier n'est pas réécrit.
- **Empreintes.** `tree_sha256` par dépôt et SHA-256 par fichier déployé, vérifiées au rejeu.
- **Chemins.** Toute écriture hors de la racine, ou à travers un lien symbolique, est refusée.

Les règles du scan sont listées dans `src/scan.ts` (`RULES`). Le scan repère des motifs connus ; il ne prouve pas qu'un paquet est sûr.

## Limites connues (v0.1)

- **Hooks avec scripts.** Un hook dont la commande pointe vers un script du paquet (`${PLUGIN_ROOT}/…`, `./…`) est ignoré avec un avertissement. Seules les commandes en ligne sont déployées.
- **Hooks non portables.** Les noms d'événements sont traduits par table ; un événement sans équivalent est ignoré avec un avertissement. Les données reçues par le hook diffèrent d'un outil à l'autre et ne sont pas adaptées.
- **Copilot et filtres de hook.** Copilot n'a pas de filtre par outil : un hook filtré (`matcher`) n'y est pas déployé, pour ne pas l'élargir à tous les outils.
- **Serveurs MCP de registre.** Seuls les serveurs auto-définis (`registry: false`) sont déployés.
- **Outils d'agent.** Les noms d'outils (`tools:`) sont propres à chaque produit. Ils sont transmis tels quels à Claude Code et abandonnés pour Codex et Cursor, avec un avertissement dans les deux cas.
- **Codex.** Pas d'instructions par fichier (Codex ne lit que `AGENTS.md`) ; la compilation d'`AGENTS.md` n'est pas implémentée.
- **Dépendances de registre** (`id:`), `git: parent`, primitives propres au projet (`local_deployed_files`) : non pris en charge.
- **Miroirs git complets.** Chaque dépôt est cloné en entier dans le cache (`~/.cache/ahub`).

## Points non confirmés par les documentations officielles

- Claude Code ne documente pas la lecture de `.agents/skills/` : les skills y vont dans `.claude/skills/`.
- Le dossier utilisateur des commandes Cursor (`~/.cursor/commands`) n'est pas documenté : les commandes ne sont pas déployées en portée utilisateur pour Cursor.
- Les champs exacts de la source `url` d'un marketplace Codex ne sont pas documentés : l'export Codex utilise `{ source, url, ref }` par analogie avec `git-subdir`.
- La lecture de `.claude-plugin/marketplace.json` par la CLI Codex n'est pas confirmée.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `AHUB_CACHE_DIR` | Dossier du cache git (défaut : `~/.cache/ahub`). |
| `AHUB_GIT_MIRRORS` | Objet JSON `{"hôte/propriétaire/dépôt": "url ou chemin"}` : remplace l'URL de clonage (miroirs d'entreprise, tests). |
| `AHUB_HOME` | Remplace le dossier personnel (tests). |
| `AHUB_CONFIG` | Chemin du fichier de configuration (défaut : `~/.config/ahub/config.json`). |
| `AHUB_USER_DIR` | Dossier du manifeste utilisateur (défaut : `~/.apm`). |

## Développement

```bash
npm install
```

```bash
npm test
```

Les tests créent de vrais dépôts git dans des dossiers temporaires ; aucun accès réseau. `git` doit être installé.

## Licence

Apache-2.0. Les schémas JSON OpenAPM de `vendor/openapm/` sont © Microsoft, sous Apache-2.0 (voir `NOTICE`).
