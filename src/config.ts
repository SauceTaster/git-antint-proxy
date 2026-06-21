/**
 * Configuration for the anti-attribution proxy.
 *
 * Loaded from (first found, merged over defaults):
 *   1. path passed on the CLI (--config)
 *   2. $ANTINT_CONFIG
 *   3. ./antint.config.json in the scanned repo
 *   4. built-in defaults
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Family, Severity } from './types.js';

export interface WorkingHoursPolicy {
  /**
   * How to treat timezone offsets and time-of-day.
   * - 'utc'      : require commit times normalised to +0000.
   * - 'quantize' : require times rounded to a coarse bucket (see `bucketMinutes`).
   * - 'off'      : do not check temporal signals.
   */
  mode: 'utc' | 'quantize' | 'off';
  /** For 'quantize': bucket size in minutes (e.g. 60 rounds to the hour). */
  bucketMinutes: number;
  /**
   * Optional working-hours window [startHour, endHour) in local 24h time.
   * Commits whose time-of-day falls *outside* this window are flagged as
   * schedule-revealing (e.g. 3am commits leak timezone even under UTC).
   * Set to null to disable the window check.
   */
  window: [number, number] | null;
  /** Flag commits whose author/committer dates differ by more than this many seconds. */
  maxAuthorCommitterSkewSeconds: number;
  /** Flag bursts: more than `maxCommitsPerMinute` commits sharing a minute. */
  maxCommitsPerMinute: number;
}

export interface CanonicalIdentity {
  name: string;
  email: string;
  /**
   * Additional author/committer identities considered "already anonymous"
   * and therefore allowed (exact `Name <email>` or bare email).
   */
  allow: string[];
}

export interface StylometryPolicy {
  /** Require LF line endings. */
  enforceLf: boolean;
  /** Flag trailing whitespace on added lines. */
  noTrailingWhitespace: boolean;
  /** 'tab' | 'space' | 'any' — required indentation unit on added lines. */
  indent: 'tab' | 'space' | 'any';
  /**
   * Map of glob -> shell command that formats stdin to stdout (or a check
   * command). Used by the formatter-drift check and by `autofix`. The token
   * `{file}` is replaced with the (shell-quoted) file path.
   * Example: a "double-star-slash *.ts" glob -> "prettier --stdin-filepath {file}".
   */
  formatters: Record<string, string>;
  /** Run formatter-drift detection (requires the formatter to be installed). */
  checkFormatterDrift: boolean;
}

export interface AntintConfig {
  identity: CanonicalIdentity;
  workingHours: WorkingHoursPolicy;
  stylometry: StylometryPolicy;
  /** Enable/disable whole families. */
  families: Record<Family, boolean>;
  /**
   * Per-family severity *cap* (ceiling). A finding's effective severity is
   * min(rule severity, cap). 'block' = no cap (the default); set a family to
   * 'warn' to make it non-blocking, or 'info' to fully mute its blocks/warns.
   * It never raises a rule's declared severity.
   */
  severityCap: Record<Family, Severity>;
  /** Rule ids to disable outright. */
  disableRules: string[];
  /** Glob patterns (file paths) that are exempt from content/path scanning. */
  allowPaths: string[];
  /** Extra user-defined rules merged into the catalog. */
  extraRules: unknown[];
  /** Treat 'warn' findings as blocking too. */
  strict: boolean;
  /**
   * Whether formatter commands in `stylometry.formatters` may be executed.
   * Only true when the config came from an explicit --config path or
   * $ANTINT_CONFIG (trusted), never from a repo-discovered antint.config.json —
   * so scanning an untrusted repo can't run arbitrary commands. Set explicitly
   * to true for programmatic use.
   */
  trustFormatters: boolean;
}

export const DEFAULT_CONFIG: AntintConfig = {
  identity: {
    name: 'Anonymous',
    email: 'anonymous@users.noreply.github.com',
    allow: [],
  },
  workingHours: {
    mode: 'utc',
    bucketMinutes: 60,
    window: null,
    maxAuthorCommitterSkewSeconds: 300,
    maxCommitsPerMinute: 30,
  },
  stylometry: {
    enforceLf: true,
    noTrailingWhitespace: true,
    indent: 'any',
    formatters: {},
    checkFormatterDrift: false,
  },
  families: {
    identity: true,
    temporal: true,
    agentic: true,
    prompt: true,
    stylometry: true,
  },
  // 'block' = no cap. Per-rule severity governs; temporal/stylometry rules are
  // already declared warn/info, so they don't block by default anyway.
  severityCap: {
    identity: 'block',
    temporal: 'block',
    agentic: 'block',
    prompt: 'block',
    stylometry: 'block',
  },
  disableRules: [],
  allowPaths: [],
  extraRules: [],
  strict: false,
  trustFormatters: false,
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return (override as T) ?? base;
  if (typeof base !== 'object' || typeof override !== 'object') return (override as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object'
      ? deepMerge(b, v as Partial<typeof b>)
      : v;
  }
  return out as T;
}

interface ConfigSource {
  path: string;
  /** Trusted sources (explicit --config / $ANTINT_CONFIG) may run formatter commands. */
  trusted: boolean;
}

function resolveConfigSource(repoPath: string, explicit?: string): ConfigSource | undefined {
  const candidates: ConfigSource[] = [
    ...(explicit ? [{ path: explicit, trusted: true }] : []),
    ...(process.env.ANTINT_CONFIG ? [{ path: process.env.ANTINT_CONFIG, trusted: true }] : []),
    { path: resolve(repoPath, 'antint.config.json'), trusted: false },
    { path: resolve(repoPath, '.antint.json'), trusted: false },
  ];
  return candidates.find((c) => existsSync(c.path));
}

export function resolveConfigPath(repoPath: string, explicit?: string): string | undefined {
  return resolveConfigSource(repoPath, explicit)?.path;
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Coerce/clamp numeric fields so untrusted config can't break shell arithmetic or logic. */
function validate(cfg: AntintConfig): AntintConfig {
  const d = DEFAULT_CONFIG.workingHours;
  const wh = cfg.workingHours;
  wh.bucketMinutes = num(wh.bucketMinutes, d.bucketMinutes, 1, 24 * 60);
  wh.maxAuthorCommitterSkewSeconds = num(wh.maxAuthorCommitterSkewSeconds, d.maxAuthorCommitterSkewSeconds, 0);
  wh.maxCommitsPerMinute = num(wh.maxCommitsPerMinute, d.maxCommitsPerMinute, 1);
  if (Array.isArray(wh.window) && wh.window.length === 2) {
    wh.window = [num(wh.window[0], 9, 0, 24), num(wh.window[1], 18, 0, 24)];
  } else {
    wh.window = null;
  }
  return cfg;
}

export function loadConfig(repoPath: string, explicit?: string): AntintConfig {
  const source = resolveConfigSource(repoPath, explicit);
  if (!source) return DEFAULT_CONFIG;
  let parsed: Partial<AntintConfig>;
  try {
    parsed = JSON.parse(readFileSync(source.path, 'utf8')) as Partial<AntintConfig>;
  } catch (err) {
    throw new Error(`Failed to parse config at ${source.path}: ${(err as Error).message}`);
  }
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  // Repo-discovered config can never be trusted to execute formatter commands.
  // A trusted source (explicit --config / $ANTINT_CONFIG) may, unless it opts out.
  merged.trustFormatters = source.trusted ? parsed.trustFormatters !== false : false;
  return validate(merged);
}
