# Agent Hub architecture

Agent Hub is a coordination control plane for teams that use multiple coding
agents on the same repository. It does not merge model-internal memory or copy
private conversations. It gives every participating agent access to the same
small, structured, auditable project context.

## Authority order

When sources disagree, clients should use this order:

1. Current Git state and project-owned source data
2. Human-approved repository rules and decisions
3. Active work leases and conflict resolutions
4. Verification records tied to a commit
5. Agent-authored observations
6. Conversation history

The service never treats an agent note as a repository instruction.

## Components

### Room service

A single server is authoritative for room membership, active leases, records,
and the append-only activity feed. Running it on a developer machine is useful
for a pilot. A team deployment should use an always-on internal host so the
room does not disappear when its creator goes offline.

### Browser workbench

The browser UI lets people create or join a room, see registered work, resolve
overlaps, publish decisions and verification, and complete a handoff. It uses
the same member token as the MCP endpoint.

### MCP adapter

The Streamable HTTP MCP endpoint exposes scoped context and coordination tools
to Codex and other MCP-capable agents. A bearer token identifies both the room
and the member. Tool descriptions and server instructions define the expected
workflow, but they are not a security boundary.

### Enforcement outside the MVP

Repository rules can require agents to call Agent Hub. Codex hooks can perform
pre-edit checks, while Git hooks or CI can enforce publication checks. These
layers are deliberately separate because clients differ in their hook support
and local hooks can be bypassed.

## Core workflow

1. A member opens a session with repository, branch, worktree, and base commit
   metadata.
2. The agent queries context for the paths relevant to its task.
3. The agent requests a time-limited read or write lease.
4. The server normalizes paths and compares them with active leases in one
   transaction.
5. The server returns `allow`, `warn`, or `deny`, with concrete conflicting
   members and paths.
6. The agent renews its lease while working and records meaningful decisions or
   verification results.
7. The agent closes the work item with actual changed paths, validation, and
   remaining risks. Closing releases its active scope but retains the audit
   trail.

## Conflict semantics

- Read/read overlap is allowed.
- Ordinary source write overlap produces a warning and requires an override
  reason to continue.
- Unity scenes, prefabs, controllers, assets, metadata, and source configuration
  are treated as high-risk resources. A write overlap is denied while the
  existing lease is active.
- Directory and file scopes overlap when either is an ancestor of the other.
- Paths are repository-relative, slash-normalized, and compared without case on
  Windows-oriented projects.
- A lease timeout removes the active claim, not the historical record.

Path checks cannot prove semantic safety. The UI therefore says "no overlap was
found in registered scopes" instead of "safe to edit".

## Stored data

The MVP stores:

- Room and project identifiers
- Member display names, roles, and hashed access tokens
- Branch, commit, worktree, and repository-relative path metadata
- Work leases, expiry, override reasons, and outcomes
- Decisions, verification, risks, and handoffs with source and timestamps
- Append-only activity events

It does not require source contents, patch bodies, prompts, private chat logs,
environment variables, or credentials. Deployments should use HTTPS before
exposing the service beyond a trusted local network.

## Persistence and scaling

SQLite is sufficient for a pilot because all clients write through one server
process and lease acquisition uses short transactions. The service owns the
database file under `AGENT_HUB_DATA_DIR`.

A later always-on deployment can replace the storage adapter with PostgreSQL.
The domain service and MCP/REST contracts should remain unchanged; Redis,
queues, and vector search are not required for the coordination use case.
