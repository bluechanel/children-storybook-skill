"""Read the host project's .env.local without pulling in a dependency.

Node scripts get this from project.mjs. The Python entry points need the same
behaviour so a globally installed skill works when invoked from any directory:
npm's --env-file-if-exists flag only applies when the caller remembers to pass it.
"""
import os
import re
from pathlib import Path

_LINE = re.compile(r'^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')

# Environment variables consulted for the project root, in order. The first is this skill's
# own neutral name, settable by any agent host; the second is what Claude Code exports for
# its Bash tool. Mirrors PROJECT_ENV in project.mjs.
PROJECT_ENV = ('CHILDREN_STORYBOOK_PROJECT', 'CLAUDE_PROJECT_DIR')


def resolve_project(explicit):
    """Same resolution order as project.mjs, so the Python and Node tools agree."""
    chosen = explicit or next((os.environ[name] for name in PROJECT_ENV if os.environ.get(name)), None)
    return Path(chosen).resolve() if chosen else Path.cwd().resolve()


def load_env_local(project):
    """Set unset variables from <project>/.env.local. Existing values always win.

    Returns the names that were set. Values are never logged.
    """
    path = Path(project) / '.env.local'
    try:
        text = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return []
    loaded = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        match = _LINE.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        if key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded
