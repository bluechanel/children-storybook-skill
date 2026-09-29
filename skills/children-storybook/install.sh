#!/usr/bin/env bash
# Install this skill into an agent's skills directory.
#
#   ./install.sh                          link (default) — one source of truth
#   ./install.sh --target ~/.agents/skills   install for a different agent host
#   ./install.sh --copy                   real copy; use to distribute to another machine
#   ./install.sh --uninstall              remove the link (a real directory needs --yes)
#
# The target is chosen in this order: --target, $SKILLS_DIR, $CLAUDE_SKILLS_DIR, then the
# first of ~/.claude/skills and ~/.agents/skills that already exists. Nothing in the skill
# itself depends on where it is installed — the scripts locate themselves.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="$(basename "$SRC")"

MODE=link
ASSUME_YES=0
TARGET_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --link) MODE=link; shift ;;
    --copy) MODE=copy; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --target) [ -n "${2:-}" ] || { echo "--target needs a directory" >&2; exit 2; }; TARGET_DIR="$2"; shift 2 ;;
    --help|-h) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

if [ -z "$TARGET_DIR" ]; then
  for candidate in "${SKILLS_DIR:-}" "${CLAUDE_SKILLS_DIR:-}" "$HOME/.claude/skills" "$HOME/.agents/skills"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then TARGET_DIR="$candidate"; break; fi
  done
fi
if [ -z "$TARGET_DIR" ]; then
  echo "No skills directory found. Pass --target <dir>, e.g. --target ~/.claude/skills" >&2
  exit 2
fi
TARGET_DIR="${TARGET_DIR%/}"
TARGET="$TARGET_DIR/$NAME"

if [ ! -f "$SRC/SKILL.md" ]; then
  echo "Error: $SRC does not look like a skill (no SKILL.md)." >&2
  exit 2
fi

mkdir -p "$TARGET_DIR"

if [ "$MODE" = uninstall ]; then
  if [ -L "$TARGET" ]; then
    rm "$TARGET"; echo "Removed link $TARGET"
  elif [ -d "$TARGET" ]; then
    if [ "$ASSUME_YES" != 1 ]; then
      echo "Error: $TARGET is a real directory, not a link. Re-run with --yes to delete it." >&2
      exit 2
    fi
    rm -rf "$TARGET"; echo "Removed directory $TARGET"
  else
    echo "Nothing installed at $TARGET"
  fi
  exit 0
fi

if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  echo "Error: $TARGET already exists and is not a symlink." >&2
  echo "Move it aside first, or run: ./install.sh --uninstall --yes" >&2
  exit 2
fi

if [ "$MODE" = copy ]; then
  mkdir -p "$TARGET"
  rsync -a --delete \
    --exclude '__pycache__' --exclude '.DS_Store' --exclude '*.pyc' \
    "$SRC/" "$TARGET/"
  echo "Copied $NAME to $TARGET"
  echo "Note: a copy does not track the original. Re-run after changing the skill."
else
  ln -sfn "$SRC" "$TARGET"
  echo "Linked $TARGET -> $SRC"
  echo "Edits in $SRC take effect immediately; nothing to re-install."
fi

echo
echo "Scripts live in $TARGET/scripts/ and resolve the project through --project,"
echo "\$CHILDREN_STORYBOOK_PROJECT, \$CLAUDE_PROJECT_DIR, or the working directory."
echo "Check the setup with: node $TARGET/scripts/where.mjs"
