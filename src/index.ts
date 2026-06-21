/**
 * git-antint-proxy — an anti-attribution git proxy.
 *
 * Inspect-and-block: detect signals that tie code to a person or workflow
 * (identity, working-time, agentic-tool, prompt, stylometry) and block or warn
 * before a push reaches the remote. Public API surface.
 */

export type {
  AddedLine,
  CatalogRule,
  Commit,
  Family,
  FileChange,
  Finding,
  Identity,
  Push,
  Rule,
  RuleKind,
  RuleScope,
  ScanResult,
  Severity,
  SignalType,
} from './types.js';

export {
  type AntintConfig,
  type CanonicalIdentity,
  DEFAULT_CONFIG,
  loadConfig,
  resolveConfigPath,
  type StylometryPolicy,
  type WorkingHoursPolicy,
} from './config.js';

export { isGitRepo, parsePush, parseTag, readBlobAtCommit, readBlobBytes, type RevSpec } from './git/parse.js';
export { allCatalogRules, loadRules } from './rules/index.js';
export { BUILTINS } from './engine/builtins.js';
export { CHAIN, scan, scanPush } from './engine/scan.js';
export { formatJson, formatText, type ReportOptions } from './report.js';
export { applyMetadataFix, type FixStep, type MetadataFixResult, planFix } from './autofix.js';
