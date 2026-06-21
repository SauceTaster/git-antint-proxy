/**
 * The inspect-and-block chain.
 *
 * Mirrors the FINOS git-proxy model: a push flows through an ordered list of
 * processors that enrich a shared context with findings. Unlike FINOS we never
 * mutate or forward the pack — we only inspect and decide block/allow. Optional
 * remediation is a separate, explicit step (autofix.ts).
 */

import { type AntintConfig, DEFAULT_CONFIG, loadConfig } from '../config.js';
import { isGitRepo, parsePush, type RevSpec } from '../git/parse.js';
import { loadRules } from '../rules/index.js';
import type { Family, Finding, Push, Rule, ScanResult, Severity } from '../types.js';
import { binaryMetadataChecks, identityChecks, stylometryChecks, temporalChecks } from './builtins.js';
import { runRuleEngine } from './ruleEngine.js';

interface ChainContext {
  push: Push;
  config: AntintConfig;
  rules: Rule[];
  findings: Finding[];
}

type Processor = { name: string; run: (ctx: ChainContext) => void };

/** The ordered processor chain. Catalog rules first, then builtin families. */
export const CHAIN: Processor[] = [
  { name: 'catalog-rules', run: (ctx) => ctx.findings.push(...runRuleEngine(ctx.push, ctx.rules, ctx.config)) },
  {
    name: 'identity',
    run: (ctx) => {
      if (ctx.config.families.identity) {
        ctx.findings.push(...identityChecks(ctx.push, ctx.config));
        ctx.findings.push(...binaryMetadataChecks(ctx.push, ctx.config));
      }
    },
  },
  {
    name: 'temporal',
    run: (ctx) => {
      if (ctx.config.families.temporal) ctx.findings.push(...temporalChecks(ctx.push, ctx.config));
    },
  },
  {
    name: 'stylometry',
    run: (ctx) => {
      if (ctx.config.families.stylometry) ctx.findings.push(...stylometryChecks(ctx.push, ctx.config));
    },
  },
];

const RANK: Record<Severity, number> = { info: 1, warn: 2, block: 3 };
const UNRANK: Record<number, Severity> = { 1: 'info', 2: 'warn', 3: 'block' };

function applyCap(severity: Severity, family: Family, config: AntintConfig): Severity {
  const cap = config.severityCap[family] ?? 'block';
  return UNRANK[Math.min(RANK[severity], RANK[cap])]!;
}

function finalize(ctx: ChainContext): ScanResult {
  const disabled = new Set(ctx.config.disableRules);
  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const f of ctx.findings) {
    if (disabled.has(f.ruleId)) continue;
    // Evidence is part of the key so distinct signals from one rule on one line
    // (e.g. author vs committer timezone) are not collapsed into a single finding.
    const key = `${f.ruleId}|${f.commit ?? ''}|${f.path ?? ''}|${f.line ?? ''}|${f.evidence ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...f, severity: applyCap(f.severity, f.family, ctx.config) });
  }

  const counts: Record<Family, number> = { identity: 0, temporal: 0, agentic: 0, prompt: 0, stylometry: 0 };
  let blocked = false;
  for (const f of findings) {
    counts[f.family]++;
    if (f.severity === 'block' || (ctx.config.strict && f.severity === 'warn')) blocked = true;
  }

  // Stable ordering: severity desc, then family, then commit/path.
  findings.sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      a.family.localeCompare(b.family) ||
      (a.commit ?? '').localeCompare(b.commit ?? '') ||
      (a.path ?? '').localeCompare(b.path ?? ''),
  );

  return { push: ctx.push, findings, blocked, counts };
}

/** Run the full chain over an already-parsed push. */
export function scanPush(push: Push, config: AntintConfig = DEFAULT_CONFIG): ScanResult {
  const ctx: ChainContext = { push, config, rules: loadRules(config), findings: [] };
  for (const proc of CHAIN) proc.run(ctx);
  return finalize(ctx);
}

/** Parse `range` in `repoPath` and scan it. Loads config from the repo unless overridden. */
export function scan(
  repoPath: string,
  range: RevSpec,
  opts: { config?: AntintConfig; configPath?: string } = {},
): ScanResult {
  if (!isGitRepo(repoPath)) throw new Error(`Not a git repository: ${repoPath}`);
  const config = opts.config ?? loadConfig(repoPath, opts.configPath);
  const push = parsePush(repoPath, range);
  return scanPush(push, config);
}
