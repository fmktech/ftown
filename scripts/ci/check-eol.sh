#!/usr/bin/env bash
# Line-ending gate for shell scripts and hook assets (roadmap P0.5).
#
# `.gitattributes` forces `text eol=lf` on these files so a Windows checkout
# with `core.autocrlf=true` cannot rewrite them to CRLF. This check proves the
# rule actually applies to every tracked file in the set and that none of them
# is stored with CRLF in the index.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$root"

pathspecs=(
  '*.sh'
  '.githooks/*'
  'bridge/bin/*'
  'bridge/claude-mod/hooks/*'
  'bridge/hooks/*'
  'bridge/muse-plugin/hooks/*'
  'bridge/opencode-plugin/*.js'
  'bridge/pi-extension/*.js'
  'bridge/skills/ftown/scripts/*'
  'chaos/qemu/init'
)

status=0
while IFS= read -r -d '' file; do
  attrs=$(git check-attr text eol -- "$file")
  text=$(sed -n 's/^.*: text: //p' <<<"$attrs")
  eol=$(sed -n 's/^.*: eol: //p' <<<"$attrs")
  if [[ $text != set || $eol != lf ]]; then
    printf 'missing "text eol=lf" attribute: %s (text=%s eol=%s)\n' "$file" "$text" "$eol" >&2
    status=1
  fi
done < <(git ls-files -z -- "${pathspecs[@]}")

while IFS=$' \t' read -r index_eol worktree_eol _ path; do
  # `git ls-files --eol` prints "<index-eol> <worktree-eol> <attr>\t<path>".
  if [[ $index_eol != i/lf || $worktree_eol != w/lf ]]; then
    printf 'not LF: %s\n' "$path" >&2
    status=1
  fi
done < <(git ls-files --eol -- "${pathspecs[@]}")

if (( status != 0 )); then
  echo '::error::Shell scripts and hook assets must be committed and checked out with LF.' >&2
  exit 1
fi

echo "line endings ok: $(git ls-files -- "${pathspecs[@]}" | wc -l | tr -d ' ') shell/hook assets are LF"
