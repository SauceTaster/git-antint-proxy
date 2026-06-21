/**
 * Data-driven rule engine: applies the catalog's regex/glob rules to a push.
 * Builtin capability checks (temporal/identity/stylometry) live in builtins.ts.
 */

import picomatch from 'picomatch';
import type { AntintConfig } from '../config.js';
import { readBlobAtCommit } from '../git/parse.js';
import type { Commit, Finding, Push, Rule } from '../types.js';

const MAX_EVIDENCE = 160;

function truncate(s: string): string {
  const clean = s.replace(/\r$/, '').trim();
  return clean.length > MAX_EVIDENCE ? `${clean.slice(0, MAX_EVIDENCE)}…` : clean;
}

function makeFinding(rule: Rule, commit: Commit, extra: Partial<Finding>): Finding {
  return {
    ruleId: rule.id,
    family: rule.family,
    severity: rule.severity,
    title: rule.title,
    commit: commit.sha,
    fix: rule.fix,
    tool: rule.tool,
    ...extra,
  };
}

function pathAllowed(matchers: ((p: string) => boolean)[], path: string): boolean {
  return matchers.some((m) => m(path));
}

export function runRuleEngine(push: Push, rules: Rule[], config: AntintConfig): Finding[] {
  const findings: Finding[] = [];
  const allowMatchers = config.allowPaths.map((g) => picomatch(g, { dot: true }));
  const allowed = (p: string) => pathAllowed(allowMatchers, p);

  // Pre-compile per rule. Strip stateful 'g'/'y' flags (we only ever exec once
  // per string) and guard compilation so an unvalidated rule list can't throw.
  const compiled = rules
    .map((rule) => {
      let re: RegExp | null = null;
      if (rule.kind === 'regex') {
        try {
          re = new RegExp(rule.detect, (rule.flags ?? '').replace(/[gy]/g, ''));
        } catch {
          return null;
        }
      }
      return { rule, re, glob: rule.kind === 'glob' ? picomatch(rule.detect, { dot: true }) : null };
    })
    .filter((x): x is { rule: Rule; re: RegExp | null; glob: ReturnType<typeof picomatch> | null } => x !== null);

  for (const commit of push.commits) {
    for (const { rule, re, glob } of compiled) {
      if (rule.kind === 'regex' && re) {
        if (rule.scope === 'commit-message') {
          const m = re.exec(commit.message);
          if (m) findings.push(makeFinding(rule, commit, { evidence: truncate(m[0]) }));
        } else if (rule.scope === 'added-line') {
          for (const file of commit.files) {
            if (file.binary || allowed(file.path)) continue;
            for (const ln of file.addedLines) {
              const m = re.exec(ln.text);
              if (m) {
                findings.push(
                  makeFinding(rule, commit, { path: file.path, line: ln.n, evidence: truncate(m[0]) }),
                );
                break; // one finding per (rule,file) is enough signal
              }
            }
          }
        } else if (rule.scope === 'file-content') {
          for (const file of commit.files) {
            if (file.binary || file.status === 'deleted' || allowed(file.path)) continue;
            const content = readBlobAtCommit(push.repoPath, commit.sha, file.path);
            if (content && re.test(content)) {
              findings.push(makeFinding(rule, commit, { path: file.path }));
            }
          }
        } else if (rule.scope === 'file-path') {
          for (const file of commit.files) {
            if (allowed(file.path)) continue;
            if (re.test(file.path) || (file.oldPath && re.test(file.oldPath))) {
              findings.push(makeFinding(rule, commit, { path: file.path, evidence: truncate(file.path) }));
            }
          }
        }
      } else if (rule.kind === 'glob' && glob) {
        for (const file of commit.files) {
          if (allowed(file.path)) continue;
          if (glob(file.path) || (file.oldPath && glob(file.oldPath))) {
            findings.push(makeFinding(rule, commit, { path: file.path }));
          }
        }
      }
    }
  }
  return findings;
}
