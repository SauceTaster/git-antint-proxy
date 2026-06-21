/**
 * Render scan results for humans (terminal) and machines (JSON / SARIF-ish).
 */

import type { Family, Finding, ScanResult, Severity } from './types.js';

const FAMILY_LABEL: Record<Family, string> = {
  identity: 'Identity (names / emails / signatures)',
  temporal: 'Working time (timezone / hours / cadence)',
  agentic: 'Agentic-tool artifacts',
  prompt: 'Leaked prompt / LLM text',
  stylometry: 'Stylometry (layout / lexical)',
};

const SEV_MARK: Record<Severity, string> = { block: '✖', warn: '⚠', info: 'ℹ' };

const COLOR: Record<Severity | 'dim' | 'reset' | 'bold', string> = {
  block: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function short(sha?: string): string {
  return sha ? sha.slice(0, 8) : '--------';
}

export interface ReportOptions {
  color?: boolean;
}

export function formatText(result: ScanResult, opts: ReportOptions = {}): string {
  const color = opts.color ?? false;
  const c = (s: string, code: keyof typeof COLOR) => (color ? `${COLOR[code]}${s}${COLOR.reset}` : s);
  const lines: string[] = [];

  const { commits } = result.push;
  lines.push(
    c('antint', 'bold') +
      `  scanned ${commits.length} commit(s) over ${result.push.range} — ${result.findings.length} finding(s)`,
  );

  if (result.findings.length === 0) {
    lines.push(c('✓ clean — no attribution signals detected', 'info'));
    return lines.join('\n');
  }

  const byFamily = new Map<Family, Finding[]>();
  for (const f of result.findings) {
    const arr = byFamily.get(f.family) ?? [];
    arr.push(f);
    byFamily.set(f.family, arr);
  }

  for (const family of Object.keys(FAMILY_LABEL) as Family[]) {
    const fs = byFamily.get(family);
    if (!fs || fs.length === 0) continue;
    lines.push('');
    lines.push(c(`${FAMILY_LABEL[family]}  (${fs.length})`, 'bold'));
    for (const f of fs) {
      const loc = [short(f.commit), f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : '']
        .filter(Boolean)
        .join(' ');
      const head = `  ${c(SEV_MARK[f.severity], f.severity)} ${c(f.severity.toUpperCase().padEnd(5), f.severity)} ${f.title}`;
      lines.push(head);
      lines.push(c(`      ${loc}  [${f.ruleId}]${f.tool ? `  ${f.tool}` : ''}`, 'dim'));
      if (f.evidence) lines.push(c(`      ↳ ${f.evidence}`, 'dim'));
      lines.push(c(`      fix: ${f.fix}`, 'dim'));
    }
  }

  lines.push('');
  const summary = (Object.keys(result.counts) as Family[])
    .filter((k) => result.counts[k] > 0)
    .map((k) => `${k}:${result.counts[k]}`)
    .join('  ');
  lines.push(c(summary, 'dim'));
  lines.push(
    result.blocked
      ? c('✖ BLOCKED — attribution signals must be scrubbed before this push is allowed', 'block')
      : c('⚠ allowed with warnings', 'warn'),
  );
  return lines.join('\n');
}

export function formatJson(result: ScanResult): string {
  return JSON.stringify(
    {
      range: result.push.range,
      commits: result.push.commits.map((x) => x.sha),
      blocked: result.blocked,
      counts: result.counts,
      findings: result.findings,
    },
    null,
    2,
  );
}
