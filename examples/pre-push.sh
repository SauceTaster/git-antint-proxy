#!/usr/bin/env bash
# Anti-attribution pre-push hook.
#
# Install:
#   cp examples/pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
#
# git feeds "<localRef> <localSha> <remoteRef> <remoteSha>" lines on stdin; antint
# scans each pushed range and exits non-zero (aborting the push) if any commit
# leaks attribution signals that must be scrubbed first.
exec antint hook pre-push --repo "$(git rev-parse --show-toplevel)"
