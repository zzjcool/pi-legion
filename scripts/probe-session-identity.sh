#!/usr/bin/env bash
# Probe: what session identity does pi actually hand to an extension?
#
# Reads real session files from pi's session store and prints the facts the
# psid design in docs/design/session-scoped-identity.md depends on:
#
#   1. every session file is named  <ISO timestamp>_<sessionId>.jsonl
#   2. the header's `id` is byte-identical to the id segment of the filename
#   3. `parentSession` is present exactly on branched/forked sessions (~ 0.x %)
#   4. no two files carry the same session id
#
# Usage:  bash scripts/probe-session-identity.sh [session-dir]
# Default session dir: ${PI_SESSION_DIR:-$HOME/.pi/agent/sessions}
#
# Read-only. No network, no writes outside $TMPDIR.

set -u -o pipefail

dir="${1:-${PI_SESSION_DIR:-$HOME/.pi/agent/sessions}}"

if [ ! -d "$dir" ]; then
	printf 'no session dir at %s\n' "$dir" >&2
	exit 1
fi

out="$(mktemp "${TMPDIR:-/tmp}/psid-probe.XXXXXX")"
trap 'rm -f "$out"' EXIT

find "$dir" -name '*.jsonl' -type f -print0 2>/dev/null | while IFS= read -r -d '' file; do
	head -1 "$file" 2>/dev/null | FILE="$file" python3 -c '
import json, os, sys
path = os.environ["FILE"]
line = sys.stdin.readline()
try:
    header = json.loads(line)
except Exception:
    sys.exit(0)
if header.get("type") != "session":
    sys.exit(0)
id_ = header.get("id") or ""
parent = header.get("parentSession") or ""
print("\t".join([path, id_, header.get("timestamp") or "", "1" if parent else "0", parent]))
'
done >"$out"

python3 - "$out" <<'PY'
import collections, os, sys

rows = []
for line in open(sys.argv[1], encoding="utf-8"):
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 5:
        continue
    rows.append(parts)

if not rows:
    print("no session headers found")
    raise SystemExit(0)

bad_name, forked, ids = [], [], collections.Counter()
for path, id_, ts, has_parent, parent in rows:
    base = os.path.basename(path)
    stem, _, _ = base.rpartition(".")
    if not stem.endswith("_" + id_):
        bad_name.append((base, id_))
    ids[id_] += 1
    if has_parent == "1":
        forked.append((id_, parent))

dups = [i for i, n in ids.items() if n > 1]
print(f"session files read     : {len(rows)}")
print(f"id == filename segment : {len(rows) - len(bad_name)} / {len(rows)}")
print(f"with parentSession     : {len(forked)}  ({100 * len(forked) / len(rows):.1f} %)")
print(f"duplicate ids          : {len(dups)}")
print(f"id length              : {sorted({len(i) for i in ids})}")
if bad_name:
    print("\nMISMATCH (filename id != header id):")
    for base, id_ in bad_name[:5]:
        print(f"  {base}  header id={id_}")
if dups:
    print("\nDUPLICATE ids:")
    for i in dups[:5]:
        print(f"  {i}")
if forked:
    print("\nbranched/forked examples (new id, old file as parent):")
    for id_, parent in forked[:3]:
        print(f"  id={id_}  parent={os.path.basename(parent)}")
PY
