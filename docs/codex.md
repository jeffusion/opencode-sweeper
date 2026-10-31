# Codex CLI cleanup

Requires **Codex CLI 0.163.0**. No OpenCode host or resident daemon is needed.

## Usage

```bash
opencode-sweeper codex          # Preview; no deletion
opencode-sweeper codex --apply  # Permanent deletion
```

`CODEX_HOME` selects the profile (default `~/.codex`). The command does not change Codex configuration.

| Option | Default | Purpose |
|---|---|---|
| `--expiry <duration>` | `30d` | Main-session retention |
| `--subagent-expiry <duration>` | `7d` | Subagent retention |
| `--recent-activity-grace <duration>` | `1h` | Additional recent-activity protection |
| `--protect <id>` | none | Protect a session; repeatable |

Both ordinary and archived sessions are included. Expiry uses `updatedAt`, not the archive timestamp. A clean preview or completed apply exits `0`; invalid input, incomplete discovery, refused deletion, or an unconfirmed result exits non-zero.

## Selection and deletion

- Each invocation starts its own temporary `codex app-server`. Official lists, standard rollout filenames, and `thread/read(includeTurns:false)` metadata are combined because native lists can omit sessions.
- Only filenames are read locally: no rollout body, index, or state-database reads, and no direct file deletion. Deletion uses the official `thread/delete` API.
- Every member of a candidate subtree must be expired and eligible. Explicit protection, active/idle state, loaded sessions, and fork references prevent unsafe parent deletion. Unknown metadata blocks deletion; `systemError` blocks the affected tree and is reported.
- Discovery is repeated before and after deletion. Only confirmed missing IDs count as deleted. Partial, rejected, or unknown results stop later deletions; requests are not retried.
- A timeout closes the command's own app-server and uses a new read-only instance to confirm what happened, then exits non-zero. It never stops another Codex process or force-releases a writer lock.

## Safety limits

Preview sends no delete requests, but Codex itself may repair metadata while listing sessions.

Native writer locks protect sessions held by another process. A writer rejection stops the whole run, even if other expired sessions remain.

Eligibility checks and deletion are not atomic. A child or fork created after the check can invalidate the decision, and concurrent archival or replacement can escape the current scan. Do not assume zero risk under arbitrary concurrent changes; review the preview and avoid making structural changes during apply.
