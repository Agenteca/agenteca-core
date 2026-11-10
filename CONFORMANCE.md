# Conformité à OpenAPM v0.1

Spécification : <https://microsoft.github.io/apm/specs/openapm-v01/> (brouillon de travail, lu le 10 novembre 2026).

**Déclaration.** `@agenteca/core` 0.1.0 vise les classes **Producer** et **Consumer** sur le sous-ensemble ci-dessous. Elle ne revendique pas une conformité complète : la spec compte 131 exigences « MUST » et seules celles listées ici ont été évaluées. Les classes **Governance** (politiques) et **Registry** ne sont pas implémentées.

**Vérification.** Les manifestes et lockfiles produits par les tests sont validés contre les schémas JSON officiels (`vendor/openapm/manifest-v0.1.48.schema.json`, `lockfile-v0.1.46.schema.json`). L'interopérabilité avec l'outil `apm` lui-même est testée dans le dépôt `agenteca-cli`.

## Choix d'implémentation à déclarer (spec §11.2)

| Sujet | Choix |
|---|---|
| Hôte par défaut (req-mf-019) | `github.com` quand `default_host:` est absent. |
| Portée utilisateur (req-tg-014) | Manifeste `~/.apm/apm.yml`, lockfile `~/.apm/apm.lock.yaml`. Cibles gérées : claude, codex, copilot, cursor. |
| `content_hash` des paquets locaux (§5.6.4) | SHA-256 de la liste triée `chemin NUL sha256(fichier)`, limitée aux fichiers de primitives. |
| Sous-modules git dans `tree_sha256` | Mode `160000`, haché sur l'identifiant du commit (cas non couvert par la spec). |
| Alias de dépendance (req-mf-025) | Validés et conservés ; sans effet sur le placement (pas de dossier `apm_modules/`). |
| Extension fournisseur | `x-ahub` par entrée du lockfile : cibles et registre de propriété des fichiers de configuration fusionnés. |

## Exigences évaluées

Légende : ✅ implémentée et testée · 🟡 partielle · ❌ non implémentée.

### Manifeste (§4)

| Exigence | État | Note |
|---|---|---|
| req-mf-001 document = dictionnaire | ✅ | |
| req-mf-002, 003 `name`, `version` | ✅ | |
| req-mf-004 version SemVer | ✅ | Diagnostic non bloquant. |
| req-mf-005 cibles valides | ✅ | |
| req-mf-006 clés inconnues conservées | ✅ | Commentaires conservés aussi. |
| req-mf-007 grammaire des dépendances | ✅ | |
| req-mf-008 paquets virtuels par extension | ✅ | |
| req-mf-009 forme canonique | ✅ | |
| req-mf-010 `git: parent` | ❌ | Rejeté avec un message explicite. |
| req-mf-011 `git` et `id` exclusifs | ✅ | |
| req-mf-012 serveurs MCP auto-définis | ✅ | |
| req-mf-014, 015, req-sc-006 `registries` | ❌ | Bloc conservé, non interprété. |
| req-mf-016 chemins locaux | 🟡 | Reconnus ; `../` hors projet accepté pour le manifeste racine, refusé depuis un paquet distant. |
| req-mf-019 `default_host` | ✅ | |
| req-mf-020 sous-ensemble YAML sûr | 🟡 | (b), (c), (d) appliqués. (a) : schéma « core » YAML 1.2 (entiers et booléens typés), `name` et `version` lus comme chaînes. |
| req-mf-022 sous-ensemble de skills insatisfait | ✅ | |
| req-mf-024 entrées `id:` jamais converties | ✅ | Les entrées `id:` ne sont pas modifiables. |
| req-mf-025 alias | 🟡 | Voir ci-dessus. |
| req-ext-001 extensions `x-*` | ✅ | |
| req-tg-008 `target` / `targets` exclusifs | ✅ | Intersection par dépendance (`targets:` de l'entrée) appliquée. |

### Lockfile (§5)

| Exigence | État | Note |
|---|---|---|
| req-lk-001 structure | ✅ | |
| req-lk-002 version jamais rétrogradée | ✅ | |
| req-lk-003 `repo_url` + `resolved_commit` | ✅ | |
| req-lk-004 version inconnue refusée | ✅ | |
| req-lk-006, 017 installation figée | 🟡 | Divergence manifeste/lockfile et `tree_sha256` vérifiés ; un fichier déployé altéré est signalé comme conflit, pas comme échec immédiat. |
| req-lk-008 champs git-semver | ✅ | |
| req-lk-011 champs non définis omis, inconnus conservés | ✅ | |
| req-lk-012 empreintes des fichiers déployés | ✅ | |
| req-lk-013 archives de registre | ❌ | |
| req-lk-014 extensions conservées | ✅ | |
| req-lk-015 `tree_sha256` | ✅ | |
| req-lk-016 enveloppes de hachage | ✅ | |
| req-lk-019 `name` / `version` informatifs | ✅ | |
| req-lk-020, 021 réconciliation par cible | 🟡 | Les fichiers et entrées possédés sont retirés quand ils ne sont plus voulus ; pas de logique par cible « déclarée ailleurs ». |
| req-lk-022 casse du dépôt | ❌ | |
| §5.3 entrée propre au projet | ❌ | Champs conservés, non gérés. |

### Résolution (§7)

| Exigence | État | Note |
|---|---|---|
| req-rs-001 intersection des plages | ✅ | Échec fermé si vide. |
| req-rs-002 tags, tags annotés, plus haut tag | ✅ | |
| req-rs-003 classement des références | ✅ | |
| req-rs-007 dialecte node-semver | ✅ | Bibliothèque `semver` de npm. |
| §7.5 rejeu du lockfile | ✅ | |
| §7.5.1 miroirs | 🟡 | Remplacement d'URL par `AHUB_GIT_MIRRORS`. |
| §7.7 mise à jour | 🟡 | Ciblée ou globale ; pas d'options avancées. |
| Conflits entre références littérales | 🟡 | La référence du manifeste racine l'emporte ; sinon échec. `conflict_resolution` non lu. |

### Primitives et cibles (§8)

| Exigence | État | Note |
|---|---|---|
| §8.1 dispositions de paquet | ✅ | APM, skill seul, collection, plugin Claude, hooks. Agent Plugins v1 lu comme un plugin. |
| req-pr-006 clé `skills` de `plugin.json` | 🟡 | Chemins déclarés suivis ; pas de déduplication canonique. |
| req-tg-002 racines de déploiement | ✅ | |
| req-tg-003 convergence `.agents/skills/` | ✅ | Option de retour aux chemins natifs. |
| req-tg-004 cibles fournisseur | 🟡 | Acceptées à la lecture, ignorées avec diagnostic. |
| req-tg-006 conversion d'agent avec perte | ✅ | Diagnostic systématique. |
| req-tg-007 compilation des instructions | ❌ | `apm compile` n'a pas d'équivalent. |
| req-tg-009 vocabulaire d'outils fermé | ❌ | Aucune cible gérée n'en a. |
| req-tg-015 agent Codex | ✅ | |
| Cibles gérées | — | claude, codex, copilot, cursor. Les autres cibles canoniques sont refusées avec un diagnostic. |

### Sécurité (§10)

| Sujet | État | Note |
|---|---|---|
| §10.6 aucune exécution à l'installation | ✅ | |
| §10.9 traversée de chemin, liens symboliques | ✅ | |
| §10.3 isolement des jetons par hôte | 🟡 | ahub ne gère aucun jeton : il s'en remet à la configuration git de l'utilisateur. |
| §10.13 à 10.15 approbation des exécutables | 🟡 | Hooks et serveurs MCP listés avant confirmation ; pas de registre d'approbation persistant. |

## Écarts volontaires

- **Commandes pour Codex.** La matrice des cibles ne prévoit pas de commandes pour Codex ; Agenteca les convertit en skills.
- **Syntaxe `@tag`.** Acceptée par la CLI seulement, toujours réécrite en `#tag` dans `apm.yml`.
