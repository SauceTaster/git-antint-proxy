/**
 * Rule loading & normalisation.
 *
 * The bundled catalog (catalog.json) holds the data-driven regex/glob rules
 * (commit trailers, agentic-tool file paths, prompt phrases, identity patterns).
 * Builtin capability checks (temporal/signature/identity-field/stylometry) live
 * in code — see engine/builtins.ts — and are not stored here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AntintConfig } from '../config.js';
import type { CatalogRule, Family, Rule, RuleKind, RuleScope, SignalType } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Fallback family derivation when a catalog entry omits it. */
function deriveFamily(signalType: SignalType): Family {
  switch (signalType) {
    case 'timestamp':
    case 'behavioral':
      return 'temporal';
    case 'signature':
    case 'identity-metadata':
      return 'identity';
    case 'layout':
    case 'lexical':
      return 'stylometry';
    case 'file-path':
    case 'commit-trailer':
      return 'agentic';
    default:
      return 'agentic';
  }
}

function deriveKind(signalType: SignalType): RuleKind {
  if (signalType === 'file-path') return 'glob';
  if (signalType === 'timestamp' || signalType === 'behavioral' || signalType === 'signature') return 'builtin';
  return 'regex';
}

function deriveScope(signalType: SignalType): RuleScope | undefined {
  switch (signalType) {
    case 'commit-trailer':
    case 'commit-message':
      return 'commit-message';
    case 'file-path':
      return 'file-path';
    case 'content-regex':
    case 'lexical':
    case 'layout':
    case 'identity-metadata':
      return 'added-line';
    default:
      return undefined;
  }
}

function normalise(raw: CatalogRule): Rule {
  const family = raw.family ?? deriveFamily(raw.signalType);
  const kind = raw.kind ?? deriveKind(raw.signalType);
  const scope = raw.scope ?? deriveScope(raw.signalType);
  return {
    id: raw.id,
    title: raw.title,
    family,
    severity: raw.severity,
    signalType: raw.signalType,
    kind,
    detect: raw.detect,
    flags: raw.flags ?? 'i',
    scope,
    tool: raw.tool || undefined,
    example: raw.example,
    falsePositiveRisk: raw.falsePositiveRisk,
    fix: raw.fix,
    source: raw.source,
    enabled: raw.enabled ?? true,
  };
}

let cachedCatalog: CatalogRule[] | null = null;

function readCatalog(): CatalogRule[] {
  if (cachedCatalog) return cachedCatalog;
  const path = resolve(here, 'catalog.json');
  const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  // Accept either a flat array or { rules: [...] } / { channels: [{rules}] }.
  let rules: CatalogRule[];
  if (Array.isArray(data)) rules = data as CatalogRule[];
  else if (data && typeof data === 'object' && Array.isArray((data as { rules?: unknown }).rules))
    rules = (data as { rules: CatalogRule[] }).rules;
  else if (data && typeof data === 'object' && Array.isArray((data as { channels?: unknown }).channels))
    rules = (data as { channels: { rules: CatalogRule[] }[] }).channels.flatMap((c) => c.rules);
  else rules = [];
  cachedCatalog = rules;
  return rules;
}

/**
 * Load the effective ruleset for a scan: bundled catalog + user `extraRules`,
 * filtered by enabled families and `disableRules`, with invalid regexes dropped.
 */
export function loadRules(config: AntintConfig): Rule[] {
  const disabled = new Set(config.disableRules);
  const raw = [...readCatalog(), ...((config.extraRules as CatalogRule[]) ?? [])];
  const out: Rule[] = [];
  for (const r of raw) {
    if (!r || !r.id) continue;
    const rule = normalise(r);
    if (!rule.enabled) continue;
    if (disabled.has(rule.id)) continue;
    if (!config.families[rule.family]) continue;
    // Validate regex rules up front; drop (with a warning) if uncompilable.
    if (rule.kind === 'regex') {
      try {
        // eslint-disable-next-line no-new
        new RegExp(rule.detect, rule.flags);
      } catch (err) {
        process.emitWarning(`Skipping rule ${rule.id}: bad regex (${(err as Error).message})`);
        continue;
      }
    }
    out.push(rule);
  }
  return out;
}

/** Exposed for tests / `antint rules` listing. */
export function allCatalogRules(): Rule[] {
  return readCatalog().map(normalise);
}
