#!/usr/bin/env bash
# Resolve the git base for turbo --affected and decide whether the change
# set forces the full task graph. Exports TURBO_SCM_BASE and CI_FORCE_ALL
# via GITHUB_ENV for the remaining steps of the calling job.
#
# Base selection:
#   pull_request      merge-base of the checked-out merge ref and the base
#                     branch (= the base tip, so the diff is the PR as merged)
#   push              github.event.before (CI_PUSH_BEFORE), falling back to
#                     HEAD^ when absent, all-zero, or unreachable
#   anything else     HEAD^, and force the full graph

set -euo pipefail

EVENT="${GITHUB_EVENT_NAME:-}"
BASE_REF="${GITHUB_BASE_REF:-}"
BEFORE="${CI_PUSH_BEFORE:-}"

resolve_base() {
    if [[ "$EVENT" == 'pull_request' ]]; then
        if ! git rev-parse --verify -q "origin/${BASE_REF}" > /dev/null; then
            git fetch origin "${BASE_REF}" --no-tags > /dev/null 2>&1
        fi
        git merge-base HEAD "origin/${BASE_REF}"
        return
    fi
    if [[ "$EVENT" == 'push' && -n "$BEFORE" ]] && ! [[ "$BEFORE" =~ ^0+$ ]]; then
        if git cat-file -e "${BEFORE}^{commit}" 2> /dev/null; then
            printf '%s\n' "$BEFORE"
            return
        fi
    fi
    git rev-parse HEAD^
}

BASE="$(resolve_base)"

FORCE_ALL=false
if [[ "$EVENT" != 'pull_request' && "$EVENT" != 'push' ]]; then
    FORCE_ALL=true
fi
# Paths that feed CI behavior or dependency resolution but belong to no
# workspace package, so turbo's hashes cannot see them. pnpm-lock.yaml is the
# exception that turbo does hash on its own; it is listed anyway because a
# lockfile move can change transitive behaviour in packages whose own files
# did not change, and over-matching costs a full run while under-matching
# silently skips validation.
if git diff --name-only "$BASE" HEAD \
    | grep -Eq '^(\.github/|scripts/|justfile$|\.npmrc$|tsconfig\.base\.json$|pnpm-workspace\.yaml$|pnpm-lock\.yaml$)'; then
    FORCE_ALL=true
fi

echo "scm base: ${BASE} (event=${EVENT:-none} force_all=${FORCE_ALL})"
{
    echo "TURBO_SCM_BASE=${BASE}"
    echo "CI_FORCE_ALL=${FORCE_ALL}"
} >> "${GITHUB_ENV:?}"
