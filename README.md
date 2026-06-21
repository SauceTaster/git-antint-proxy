# git-antint-proxy

**An anti-attribution git proxy.** It inspects a push for anything that ties code
to a *person* or to a specific *workflow* — and blocks (or warns about) it before
the push reaches the remote.

Modeled on the [FINOS Git Proxy](https://github.com/finos/git-proxy) inspect-and-block
design: a push flows through a chain of detectors that enrich a shared result and
decide *allow / block*. Unlike a rewriting proxy, it never silently mutates and
forwards your history — it tells you exactly what leaks, and remediation is an
explicit, opt-in step.

> **Why.** Code is a tool to build people up; it shouldn't be a fingerprint.
> Authorship attribution on source code is real and strong — Caliskan-Islam et al.
> de-anonymized **1,600 programmers at 94% accuracy** from coding style alone
> ([USENIX 2015](https://www.usenix.org/system/files/conference/usenixsecurity15/sec15-paper-caliskan-islam.pdf)).
> This tool is for contributors who need to publish code without publishing
> *themselves*: their name, their timezone, their work schedule, their toolchain,
> or their coding fingerprint.

## What it detects

Five families of attribution signal (each toggleable, each with its own severity floor):

| Family | What leaks | Examples caught |
| --- | --- | --- |
| **identity** | names, emails, signatures, handles, author tags | non-canonical author/committer, GPG/SSH signatures, `Co-authored-by:`/`Signed-off-by:` person trailers, `@author` tags, `TODO(name)`, home-dir paths leaking a username, `.mailmap`/`AUTHORS`, committed `.gitconfig` |
| **temporal** | timezone, working hours, cadence (behavioral biometrics) | non-UTC offset, 3 a.m. commits revealing a schedule, author/committer skew, commit-burst fingerprints |
| **agentic** | AI-coding-tool artifacts | `🤖 Generated with Claude Code`, Copilot/Cursor/Aider/Codex co-author trailers & bot identities, `CLAUDE.md`, `.cursor/`, `.aider*`, `AGENTS.md`, `.windsurfrules`, `GEMINI.md`, session/prompt logs, CI bots |
| **prompt** | leaked prompt / LLM text in the tree | "As an AI language model", refusal/cutoff boilerplate, ChatML role markers, pasted chat transcripts |
| **stylometry** | layout & lexical fingerprints | CRLF, trailing whitespace, indentation style, formatter drift, brace/quote/naming idioms |

The agentic/identity/prompt rules come from a **web-verified detection catalog**
(`src/rules/catalog.json`, 150 rules as of June 2026) built by a parallel research
sweep across the major and emerging AI coding tools; per-channel research notes are
in [`docs/catalog-notes.md`](docs/catalog-notes.md). Temporal, signature, canonical-identity,
and core layout checks are **builtin capability checks** (`src/engine/builtins.ts`)
so they can be parameterized by your policy.

## Install

```bash
npm install
npm run build      # compiles to dist/ and bundles the rule catalog
npm test           # 13 end-to-end tests against real temp repos
```

## Usage

```bash
# Scan the commits you're about to push (defaults to @{upstream}..HEAD)
antint scan
antint scan origin/main..HEAD --no-color
antint scan HEAD --json                 # machine-readable

# Show a remediation plan; --write applies the automated metadata fixes
antint fix origin/main..HEAD            # dry run
antint fix origin/main..HEAD --write    # rewrite metadata (creates a backup branch)

# List the active ruleset
antint rules --family agentic

# Run as a git hook (reads ref updates from stdin)
antint hook pre-push
antint hook pre-receive
```

Exit codes: **0** clean/allowed · **1** blocked · **2** error.

### As a git hook

```bash
cp examples/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

A **server-side** `pre-receive` hook makes the policy enforceable for a whole team
(no client cooperation required) — the truest "proxy" deployment.

### As a FINOS git-proxy plugin

`git-antint-proxy/plugin` exports a `PushActionPlugin` adapter so the engine runs as
a step in a FINOS push chain — see [`examples/finos-plugin.mjs`](examples/finos-plugin.mjs).

```js
import { createAntintPushPlugin } from 'git-antint-proxy/plugin';
export default await createAntintPushPlugin();
```

## Configuration

Drop an `antint.config.json` in the repo (or pass `--config`, or set `$ANTINT_CONFIG`).
See [`antint.config.example.json`](antint.config.example.json). Highlights:

- `identity` — the canonical anonymous identity, plus an `allow` list of identities
  considered already-anonymous.
- `workingHours` — `mode: utc | quantize | off`, an optional `[start,end)` working
  window, skew and cadence thresholds.
- `stylometry` — line-ending/whitespace/indent policy and per-glob `formatters`
  (used by formatter-drift detection and autofix).
- `families` — turn whole families on/off.
- `severityCap` — per-family severity ceiling. `block` (default) = no cap, so each
  rule's own severity governs; set a family to `warn` to make it non-blocking, or
  `info` to fully mute it. It never *raises* severity.
- `trustFormatters` — only a config from an explicit `--config`/`$ANTINT_CONFIG`
  (never a repo-discovered file) may execute formatter commands; this is the gate.
- `disableRules`, `allowPaths`, `extraRules`, `strict`.

## Programmatic API

```ts
import { scan, formatText, planFix } from 'git-antint-proxy';

const result = scan(process.cwd(), 'origin/main..HEAD');
if (result.blocked) {
  console.error(formatText(result, { color: true }));
  process.exit(1);
}
```

## Limitations (read these)

- **Stylometry is layout-deep, not AST-deep.** Normalizing whitespace, line endings,
  and formatter style flattens the *layout* fingerprint, but Caliskan et al. show the
  *syntactic* (AST-shape) features are the robust ones and are **not** defeated by
  reformatting. True style obfuscation (identifier renaming, control-flow
  normalization) is out of scope here and is an open research problem.
- **Residual machine fingerprint.** Even with every human signal scrubbed, agentic
  code carries a detectable *machine-authorship* fingerprint (the "AI fingerprint"
  literature). This tool unties code from a *person*; it does not claim to make AI
  output indistinguishable from human output.
- **Binary metadata is best-effort.** EXIF/XMP/PDF author extraction is a byte-scan
  for common markers (`/Author`, `dc:creator`, EXIF `Artist`, …), not a full parser;
  install `exiftool` and strip with `exiftool -all=` for real coverage.
- **PR/MR bodies** aren't on the push path, so the hook can't see them — run a scan
  over `gh pr view --json title,body` output in CI as a separate step.
- **`fix --write` rewrites history** via `git filter-branch` and changes commit SHAs.
  It creates a backup branch first; only run it on local, not-yet-shared commits.
- **False positives exist** — broad lexical rules (`TODO(name)`, generic emails) are
  marked `warn`/`info` and `falsePositiveRisk`. Tune via `disableRules`/`allowPaths`.

What *is* covered that's easy to miss: **merge commits** (scanned via the
first-parent diff, so conflict-resolution content can't slip through), **annotated
tags** (tagger identity/date/message/signature, in hook mode), **git notes**
(scanned as their note-commit diffs in hook mode), and **non-ASCII file paths**
(`core.quotepath=false`, so they don't bypass content/stylometry scanning).

## License

MIT.
