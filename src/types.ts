/**
 * Core domain model for the anti-attribution git proxy.
 *
 * The proxy inspects a push (a set of commits and their diffs) for signals that
 * tie the code to a *person* or to a specific *workflow*, and blocks or warns
 * before the push reaches the remote. Nothing here mutates history on its own —
 * remediation is opt-in (see autofix.ts).
 */

/** The five families of attribution signal this proxy targets. */
export type Family =
  | 'identity' // names, emails, signatures, handles, author tags
  | 'temporal' // timezones, working hours, cadence (behavioral biometrics)
  | 'agentic' // AI-coding-tool artifacts: trailers, config/instruction files, bot identities
  | 'prompt' // leaked prompt text / tell-tale LLM phrasing committed into the tree
  | 'stylometry'; // layout & lexical fingerprints (indentation, quotes, naming, ...)

export type Severity = 'block' | 'warn' | 'info';

/**
 * How a rule's `detect` field is interpreted by the engine.
 * - `regex`  : `detect` is a JS regular-expression source, matched against text
 *              (commit message, an added diff line, a file's content).
 * - `glob`   : `detect` is a glob, matched against changed file paths.
 * - `builtin`: evaluated by a named, config-parameterised handler in code
 *              (timestamps, signatures, identity fields, formatter drift, ...).
 */
export type RuleKind = 'regex' | 'glob' | 'builtin';

/** What a rule scans over (for regex rules). */
export type RuleScope =
  | 'commit-message'
  | 'added-line' // a line added by the diff (leading '+')
  | 'file-content' // full content of a changed file at the pushed revision
  | 'file-path'; // the changed path itself

export type SignalType =
  | 'commit-trailer'
  | 'commit-message'
  | 'file-path'
  | 'content-regex'
  | 'identity-metadata'
  | 'timestamp'
  | 'behavioral'
  | 'layout'
  | 'lexical'
  | 'signature';

/**
 * A single detection rule. Mirrors the catalog schema produced by the
 * research sweep, plus a few engine-only fields (`kind`, `scope`, `family`,
 * `flags`, `enabled`) derived/added at load time.
 */
export interface Rule {
  id: string;
  title: string;
  family: Family;
  severity: Severity;
  signalType: SignalType;
  kind: RuleKind;
  /** Regex source (kind=regex), glob (kind=glob), or builtin handler id (kind=builtin). */
  detect: string;
  /** Regex flags for kind=regex. Defaults to 'i' (case-insensitive). */
  flags?: string;
  /** For regex rules: what text the pattern runs against. */
  scope?: RuleScope;
  /** Originating AI tool/vendor, when applicable. */
  tool?: string;
  example?: string;
  falsePositiveRisk?: 'low' | 'medium' | 'high';
  /** Human-facing remediation guidance. */
  fix: string;
  source?: string;
  enabled: boolean;
}

/** The raw rule shape as stored in catalog.json (engine fields optional). */
export type CatalogRule = Omit<Rule, 'kind' | 'enabled' | 'family'> &
  Partial<Pick<Rule, 'kind' | 'enabled' | 'family'>> & { channel?: string };

/** A git identity (author or committer). */
export interface Identity {
  name: string;
  email: string;
  /** Seconds since epoch. */
  timestamp: number;
  /** Raw timezone offset as recorded by git, e.g. "+0000", "-0700". */
  tz: string;
}

/** A line added by a diff: its new-file line number and content ('+' stripped). */
export interface AddedLine {
  n: number;
  text: string;
}

export interface FileChange {
  /** Path at the new revision (or old path for deletes). */
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  /** Lines added by this change (content only, '+' stripped). Empty for binary. */
  addedLines: AddedLine[];
  binary: boolean;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  /** Full raw commit message (subject + body). */
  message: string;
  /** True if the commit carries a GPG/SSH signature. */
  signed: boolean;
  signatureType?: 'gpg' | 'ssh' | 'x509' | 'unknown';
  files: FileChange[];
}

/** The parsed unit of work flowing through the chain. */
export interface Push {
  /** What produced this push view, e.g. "origin/main..HEAD". */
  range: string;
  repoPath: string;
  commits: Commit[];
}

/** A single detected attribution signal. */
export interface Finding {
  ruleId: string;
  family: Family;
  severity: Severity;
  title: string;
  /** Where the signal was found. */
  commit?: string;
  path?: string;
  line?: number;
  /** The offending text (already redacted/truncated for safe display). */
  evidence?: string;
  fix: string;
  tool?: string;
}

/** Result of running the chain over a push. */
export interface ScanResult {
  push: Push;
  findings: Finding[];
  /** True when any blocking finding is present (and not allow-listed). */
  blocked: boolean;
  /** Per-family counts for the summary. */
  counts: Record<Family, number>;
}
