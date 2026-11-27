#!/bin/sh
# Dev helper (inside the dev container): each test file alone with a time limit,
# so a hang points at one file instead of freezing the whole run.
cd /work/scaffold/server || exit 1
for f in $(find src -name '*.test.ts' | sort); do
  echo "=== $f"
  timeout 90 node --import tsx --test "$f" 2>&1 | grep -E '^(not ok|ok)|^# (pass|fail|skipped)|AssertionError|error:|expected|actual|Error' | head -25
  echo "exit: $?  (pipeline status of grep; a hang shows as no summary line)"
done
