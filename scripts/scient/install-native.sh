#!/usr/bin/env bash
# Install the exact addons this run produced for one platform.
set -euo pipefail

artifacts=${1:?native artifact directory required}
target=${2:?native target required}
destination=packages/natives/native
host=${target/#windows-/win32-}
variants=(default)
if [[ "$target" == *-x64 ]]; then variants=(baseline modern); fi

for variant in "${variants[@]}"; do
   artifact="$artifacts/natives-$target-$variant"
   addon="pi_natives.$host"
   if [[ "$variant" != default ]]; then addon="$addon-$variant"; fi
   for file in "$addon.node" index.d.ts; do
      if [[ ! -s "$artifact/$file" ]]; then
         printf 'Missing or empty native build output: %s\n' "$artifact/$file" >&2
         exit 1
      fi
   done
   cp "$artifact/$addon.node" "$destination/"
   # The modern declaration wins on x64, as when modern built second.
   cp "$artifact/index.d.ts" "$destination/"
done
bun packages/natives/scripts/gen-enums.ts
