import { isUtf8 } from 'node:buffer';
import { sha256Hex } from './hash.js';

export type Severity = 'critical' | 'warning' | 'info';

export interface ScanRule {
  id: string;
  name: string;
  severity: Severity;
  description: string;
  help: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface ScanInput {
  path: string;
  bytes: Buffer;
}

/**
 * Règles du scan. Les classes de points de code reprennent l'état de l'art
 * (scanner d'APM, Cisco skill-scanner, « Trojan Source ») ; AHUB-U007
 * (homoglyphes) et les règles AHUB-P* sont propres à Agenteca.
 */
export const RULES: ScanRule[] = [
  {
    id: 'AHUB-U001',
    name: 'unicode-tags',
    severity: 'critical',
    description: 'Caractères du bloc Unicode « Tags » (U+E0000–E007F), invisibles et lisibles par un modèle.',
    help: 'Supprimez ces caractères : ils servent à cacher des instructions (« ASCII smuggling »).',
  },
  {
    id: 'AHUB-U002',
    name: 'bidi-control',
    severity: 'critical',
    description: 'Contrôles bidirectionnels (U+202A–202E, U+2066–2069) qui réordonnent le texte affiché.',
    help: 'Supprimez ces caractères : le texte lu par le modèle diffère de celui affiché (« Trojan Source »).',
  },
  {
    id: 'AHUB-U003',
    name: 'variation-selector-supplement',
    severity: 'critical',
    description:
      'Sélecteurs de variation supplémentaires (U+E0100–E01EF), utilisables pour encoder des données cachées.',
    help: 'Supprimez ces caractères.',
  },
  {
    id: 'AHUB-U004',
    name: 'invalid-encoding',
    severity: 'critical',
    description: 'Fichier texte dont l’encodage UTF-8 est invalide (substituts isolés, séquences tronquées).',
    help: 'Réenregistrez le fichier en UTF-8 valide.',
  },
  {
    id: 'AHUB-U005',
    name: 'zero-width',
    severity: 'warning',
    description:
      'Caractères invisibles (largeur nulle, marques bidi, opérateurs invisibles, trait d’union conditionnel, BOM en milieu de fichier).',
    help: 'Vérifiez qu’ils sont légitimes (par exemple dans un texte en arabe ou en hindi), sinon supprimez-les.',
  },
  {
    id: 'AHUB-U006',
    name: 'unusual-whitespace',
    severity: 'info',
    description: 'Espaces inhabituelles (insécable, cadratin, idéographique, séparateurs de ligne).',
    help: 'Sans danger en général ; à vérifier dans une commande ou un nom.',
  },
  {
    id: 'AHUB-U007',
    name: 'mixed-script-confusable',
    severity: 'warning',
    description:
      'Mot mêlant lettres latines et lettres cyrilliques ou grecques d’apparence identique (homoglyphes).',
    help: 'Vérifiez le mot : il peut imiter un nom de commande, de fichier ou de domaine.',
  },
  {
    id: 'AHUB-P001',
    name: 'pipe-to-shell',
    severity: 'critical',
    description: 'Téléchargement exécuté directement par un interpréteur (curl … | sh).',
    help: 'Un paquet d’agents ne doit pas faire exécuter du code téléchargé. Refusez ou examinez l’URL.',
  },
  {
    id: 'AHUB-P002',
    name: 'encoded-execution',
    severity: 'critical',
    description: 'Contenu encodé puis exécuté (base64 -d | sh, eval(atob(…))).',
    help: 'Décodez et lisez le contenu avant toute installation.',
  },
  {
    id: 'AHUB-P003',
    name: 'instruction-override',
    severity: 'warning',
    description:
      'Formulation demandant d’ignorer les instructions précédentes ou de cacher une action à l’utilisateur.',
    help: 'Relisez le passage : c’est la forme typique d’une injection de consignes.',
  },
  {
    id: 'AHUB-P004',
    name: 'credential-access',
    severity: 'warning',
    description: 'Référence à des secrets locaux (clés SSH, identifiants cloud, fichiers .env, jetons).',
    help: 'Vérifiez que l’agent a une raison légitime de lire ces fichiers.',
  },
  {
    id: 'AHUB-P005',
    name: 'hidden-comment-instruction',
    severity: 'warning',
    description: 'Commentaire HTML (invisible au rendu Markdown) contenant des consignes.',
    help: 'Lisez le commentaire : le modèle le voit, pas le lecteur.',
  },
  {
    id: 'AHUB-P006',
    name: 'exfiltration',
    severity: 'warning',
    description:
      'Envoi de données vers l’extérieur (requête sortante avec contenu de fichier ou de variable d’environnement, URL vers une adresse IP).',
    help: 'Vérifiez la destination et les données envoyées.',
  },
];

const RULE = new Map(RULES.map((r) => [r.id, r]));

function codepointRule(cp: number, atStart: boolean): string | undefined {
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'AHUB-U001';
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'AHUB-U002';
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 'AHUB-U003';
  if (cp === 0xfeff) return atStart ? undefined : 'AHUB-U005';
  if (
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x061c ||
    cp === 0x2060 ||
    (cp >= 0x2061 && cp <= 0x2064) ||
    cp === 0x00ad ||
    (cp >= 0x206a && cp <= 0x206f) ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    cp === 0x180e ||
    (cp >= 0xfe00 && cp <= 0xfe0e)
  ) {
    return 'AHUB-U005';
  }
  if (
    cp === 0x00a0 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000 ||
    cp === 0x2028 ||
    cp === 0x2029
  ) {
    return 'AHUB-U006';
  }
  return undefined;
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

// Lettres cyrilliques et grecques confondables avec des lettres latines.
const CONFUSABLE = /[аеорсухіјһАВЕКМНОРСТХοανρΑΒΕΗΙΚΜΝΟΡΤΧ]/;
const LATIN = /[A-Za-z]/;
const WORD = /[\p{L}\p{N}_.-]+/gu;

interface PatternRule {
  id: string;
  re: RegExp;
}

const PATTERNS: PatternRule[] = [
  { id: 'AHUB-P001', re: /\b(?:curl|wget|fetch)\b[^\n|;]{0,300}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i },
  { id: 'AHUB-P001', re: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]{0,300}\|\s*iex\b/i },
  { id: 'AHUB-P001', re: /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b/i },
  { id: 'AHUB-P002', re: /base64\s+(?:-d|--decode|-D)\b[^\n]{0,120}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i },
  { id: 'AHUB-P002', re: /\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(/i },
  { id: 'AHUB-P002', re: /\bexec\s*\(\s*(?:base64\.b64decode|bytes\.fromhex|codecs\.decode)\s*\(/i },
  {
    id: 'AHUB-P003',
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  },
  {
    id: 'AHUB-P003',
    re: /\b(?:ignore[zr]?|oublie[zr]?)\s+(?:toutes\s+)?(?:les\s+)?(?:instructions?|consignes?|règles?)\s+(?:précédentes?|ci-dessus|antérieures?|système)/i,
  },
  {
    id: 'AHUB-P003',
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to|show)\s+(?:the\s+)?user\b/i,
  },
  {
    id: 'AHUB-P003',
    re: /\bne\s+(?:le\s+)?(?:dis|dites|révèle[sz]?|mentionne[sz]?)\s+(?:pas|jamais)\s+(?:cela\s+)?à\s+l['’]utilisateur/i,
  },
  {
    id: 'AHUB-P004',
    re: /(?:~|\$HOME|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/\.(?:ssh|aws|gnupg|kube|docker|netrc|npmrc|config\/gcloud)\b/,
  },
  {
    id: 'AHUB-P004',
    re: /\bid_(?:rsa|ed25519|ecdsa)\b|\b(?:cat|read|print|send|upload|type)\b[^\n]{0,60}\.env\b/i,
  },
  {
    id: 'AHUB-P004',
    re: /\b(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|NPM_TOKEN)\b[^\n]{0,80}\b(?:curl|wget|http|send|post|upload)/i,
  },
  {
    id: 'AHUB-P006',
    re: /\b(?:curl|wget)\b[^\n]{0,200}(?:-d|--data(?:-binary|-raw)?|-F|--form|--upload-file|-T)\s+["']?[@$]/i,
  },
  { id: 'AHUB-P006', re: /\bhttps?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\//i },
];

const HIDDEN_COMMENT = /<!--([\s\S]*?)-->/g;
const IMPERATIVE =
  /\b(?:you\s+(?:must|should|are|will)|always|never|ignore|execute|run\s+the|send|do\s+not|tu\s+dois|vous\s+devez|toujours|jamais|exécute[zr]?|envoie[zr]?)\b/i;

function isProbablyText(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8000).includes(0);
}

/** Analyse un fichier. Les fichiers binaires ne sont pas inspectés. */
export function scanFile(input: ScanInput): Finding[] {
  const findings: Finding[] = [];
  const { path: filePath, bytes } = input;
  if (!isProbablyText(bytes)) return findings;
  const push = (ruleId: string, line: number, column: number, message: string): void => {
    findings.push({ ruleId, severity: RULE.get(ruleId)!.severity, path: filePath, line, column, message });
  };

  if (!isUtf8(bytes)) {
    push(
      'AHUB-U004',
      1,
      1,
      'Encodage UTF-8 invalide : le contenu réellement lu par un modèle est imprévisible.',
    );
  }
  const textContent = bytes.toString('utf8');
  const lines = textContent.split(/\r\n|\n|\r/);

  // Un seul constat par règle et par ligne, pour rester lisible.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const seen = new Set<string>();
    let col = 0;
    for (const ch of line) {
      col += 1;
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) continue;
      const ruleId = codepointRule(cp, i === 0 && col === 1);
      if (ruleId && !seen.has(ruleId)) {
        seen.add(ruleId);
        const count = [...line].filter((c) => codepointRule(c.codePointAt(0)!, false) === ruleId).length;
        push(
          ruleId,
          i + 1,
          col,
          `${RULE.get(ruleId)!.description} Premier caractère : ${hex(cp)}${count > 1 ? ` (${count} sur la ligne)` : ''}.`,
        );
      }
    }
    if (CONFUSABLE.test(line)) {
      for (const m of line.matchAll(WORD)) {
        const word = m[0];
        if (LATIN.test(word) && CONFUSABLE.test(word)) {
          push(
            'AHUB-U007',
            i + 1,
            (m.index ?? 0) + 1,
            `Le mot « ${word} » mélange des lettres latines et des homoglyphes cyrilliques ou grecs.`,
          );
          break;
        }
      }
    }
    const matched = new Set<string>();
    for (const p of PATTERNS) {
      if (matched.has(p.id)) continue;
      const m = p.re.exec(line);
      if (m) {
        matched.add(p.id);
        push(p.id, i + 1, m.index + 1, `${RULE.get(p.id)!.description} Extrait : « ${m[0].slice(0, 120)} »`);
      }
    }
  }

  if (/\.(md|mdc|markdown)$/i.test(filePath)) {
    for (const m of textContent.matchAll(HIDDEN_COMMENT)) {
      const body = m[1] ?? '';
      if (body.trim().length >= 20 && IMPERATIVE.test(body)) {
        const line = textContent.slice(0, m.index).split('\n').length;
        push(
          'AHUB-P005',
          line,
          1,
          `Commentaire HTML contenant des consignes : « ${body.trim().replace(/\s+/g, ' ').slice(0, 120)} »`,
        );
      }
    }
  }
  return findings;
}

export function scanFiles(inputs: ScanInput[]): Finding[] {
  return inputs.flatMap(scanFile);
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}

export function summarizeFindings(findings: Finding[]): { critical: number; warning: number; info: number } {
  const s = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) s[f.severity] += 1;
  return s;
}

const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  warning: 'warning',
  info: 'note',
};
const SECURITY_SEVERITY: Record<Severity, string> = { critical: '9.1', warning: '5.0', info: '1.0' };

/** Produit un rapport SARIF 2.1.0 acceptable par GitHub code scanning. */
export function toSarif(findings: Finding[], toolVersion: string): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ahub',
            informationUri: 'https://github.com/agenteca/agenteca-core',
            version: toolVersion,
            rules: RULES.map((r) => ({
              id: r.id,
              name: r.name,
              shortDescription: { text: r.description },
              fullDescription: { text: r.description },
              help: { text: r.help },
              defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
              properties: { tags: ['security'], 'security-severity': SECURITY_SEVERITY[r.severity] },
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: SARIF_LEVEL[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path.split('/').map(encodeURIComponent).join('/') },
                region: { startLine: f.line, startColumn: f.column },
              },
            },
          ],
          partialFingerprints: {
            primaryLocationLineHash: sha256Hex(`${f.ruleId}:${f.path}:${f.line}`).slice(0, 32),
          },
        })),
      },
    ],
  };
}
