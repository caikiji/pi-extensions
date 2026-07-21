# pi-extensions

Personal [pi](https://github.com/earendil-works/pi-mono) extensions, packaged for `pi install`.

## Contents

| Extension | Description |
|-----------|-------------|
| `permission-gate` | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, chmod/chown 777) |
| `todo` | Todo list tool + `/todos` command with session-persisted state |
| `subagent` | Delegate tasks to specialized subagents with isolated context windows |
| `plan-mode` | Read-only exploration mode: disables write tools, bash allowlist, extracts numbered plans, tracks `[DONE:n]` progress |

## Install

```bash
pi install git:github.com/caikiji/pi-extensions@main
```

Install is written to user settings (`~/.pi/agent/settings.json`). Use `-l` for project-local (`.pi/settings.json`).

## Update

```bash
pi update git:github.com/caikiji/pi-extensions
# or
pi update --extensions
```

## Remove

```bash
pi remove git:github.com/caikiji/pi-extensions
```
