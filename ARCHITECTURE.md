# Architecture

This document is the single source of truth for the design and progress of
this project. It is updated at the end of every chunk of work.

## 1. Goals and non-goals

### Goals

- Build a Redis-like server **from scratch** in TypeScript, on raw Node.js
  `net` TCP sockets — no web/app frameworks, no existing RESP or Redis
  libraries in the core engine.
- Implement enough of the RESP protocol and command surface to be a
  genuinely useful learning tool: strings, hashes, lists, sets, sorted
  sets, expiry, pub/sub, basic transactions, and simple persistence
  (AOF + snapshotting).
- Make the internals easy to read and reason about — this is a
  **learning and portfolio project**, optimized for clarity of
  implementation over raw performance or feature completeness.
- Have a real, if simplified, test suite: unit tests, integration tests
  that talk to a running instance over an actual socket, and benchmark
  scripts that compare against real Redis so performance claims are
  grounded in numbers.

### Non-goals (explicitly out of scope)

This is **not** a production-grade Redis replacement. The following
real-Redis features are intentionally out of scope, at least for the
foreseeable roadmap:

- Cluster mode, sharding, and hash-slot routing.
- Replication beyond a possible simple/naive leader-follower demo later
  (see checklist — unscheduled, may never happen).
- Redis Sentinel / high-availability failover.
- Lua scripting (`EVAL`/`EVALSHA`) and server-side scripting in general.
- Modules / the Redis Modules API.
- ACL / multi-user auth, TLS, and other security hardening expected of a
  production deployment.
- Full data-type command coverage (e.g. HyperLogLog, geospatial commands,
  streams, bitfields) — only the common, teachable subset of each data
  type is planned.
- Performance parity with real Redis. Benchmarks exist to _compare and
  understand the gap_, not to close it.
- Disk-format compatibility with real Redis RDB/AOF files. Persistence
  here is our own simplified format, inspired by Redis but not
  interoperable with it.

## 2. High-level components

- **TCP server** — accepts raw TCP connections (Node `net` module),
  manages the connection lifecycle, and wires each socket's byte stream
  into the RESP parser and back out through the serializer. No HTTP, no
  framework — just sockets.
- **RESP protocol parser/serializer** — the parser turns incoming raw
  bytes into structured command arrays (handling partial reads/buffered
  chunks, since TCP gives no message boundaries). The serializer turns
  command results (or errors) back into RESP wire format to write to the
  socket.
- **In-memory data store** — the actual key/value engine: strings,
  hashes, lists, sets, sorted sets, held in memory (plain JS structures
  under the hood). Owns the canonical state of the dataset.
- **Command dispatcher** — takes a parsed command (array of RESP bulk
  strings), looks it up in a command table, validates arity/arguments,
  and invokes the corresponding handler against the data store.
- **Persistence (AOF + snapshotting)** — Append-Only File: logs every
  write command so state can be replayed on restart. Snapshotting: a
  `SAVE` command (plus a basic background trigger) dumps the whole
  dataset to disk as JSON (our own format, not RDB-compatible). At
  startup, one or the other is loaded — never both — per the precedence
  rule in section 7's Snapshotting checklist entry.
- **Pub/sub** — channel subscription registry; `PUBLISH` looks up
  subscribed connections for a channel and pushes messages directly to
  their sockets, independent of the normal request/response command
  flow.
- **Expiry engine** — tracks TTLs set via `EXPIRE`/`PEXPIRE`/etc. and is
  responsible for both passive expiry (checked on key access) and active
  expiry (a periodic sweep), mirroring Redis's approach at a small scale.

## 3. Folder structure

```
redis-from-scratch/
├── src/
│   ├── server/
│   │   └── tcpServer.ts        # Owns the net.Server, connection lifecycle, socket <-> parser/dispatcher wiring
│   ├── protocol/
│   │   ├── respTypes.ts        # Shared RespValue type + constructor helpers used by both below
│   │   ├── respParser.ts       # Streaming RESP decoder: bytes in, parsed commands out
│   │   └── respSerializer.ts   # Encodes command results/errors into RESP wire format
│   ├── store/
│   │   └── dataStore.ts        # In-memory key/value engine (strings, hashes, lists, sets, sorted sets)
│   ├── commands/
│   │   └── dispatcher.ts       # Command table lookup, arity/arg validation, handler invocation
│   ├── persistence/
│   │   ├── aof.ts              # Append-only write log + replay on startup
│   │   ├── snapshot.ts         # Point-in-time full-dataset snapshot dump/load + AOF-vs-snapshot startup precedence
│   │   └── snapshotScheduler.ts # Background save trigger: every N writes or every M ms
│   ├── pubsub/
│   │   └── pubsub.ts           # Channel subscription registry and message fan-out
│   ├── expiry/
│   │   └── expiryEngine.ts     # TTL tracking, passive + active key expiry
│   ├── config/
│   │   └── config.ts           # Server configuration (port, persistence paths/intervals, etc.)
│   ├── types/
│   │   └── index.ts            # Shared TypeScript types/interfaces used across modules
│   └── index.ts                # Entry point: reads config, boots the TCP server
├── test/
│   ├── unit/                    # Per-module unit tests (mirrors src/ structure)
│   │   ├── protocol/
│   │   │   ├── respParser.test.ts
│   │   │   ├── respSerializer.test.ts
│   │   │   └── respRoundTrip.test.ts
│   │   ├── store/
│   │   │   └── dataStore.test.ts
│   │   ├── commands/
│   │   │   └── dispatcher.test.ts
│   │   ├── expiry/
│   │   │   └── expiryEngine.test.ts
│   │   ├── persistence/
│   │   │   ├── aof.test.ts
│   │   │   ├── snapshot.test.ts
│   │   │   └── snapshotScheduler.test.ts
│   │   └── config.test.ts
│   ├── integration/             # Spins up the real server, talks to it over a real socket
│   │   ├── tcpServer.test.ts    # Transport/connection-lifecycle behavior
│   │   ├── coreCommands.test.ts # Real RESP commands end-to-end (PING/SET/GET/DEL/EXISTS)
│   │   ├── listCommands.test.ts # Real RESP list commands end-to-end, incl. WRONGTYPE
│   │   ├── hashCommands.test.ts # Real RESP hash commands end-to-end, incl. WRONGTYPE
│   │   ├── setCommands.test.ts  # Real RESP set commands end-to-end, incl. WRONGTYPE
│   │   ├── expiry.test.ts       # EXPIRE/TTL/PERSIST end-to-end, incl. passive expiry with no sweep running
│   │   ├── persistence.test.ts  # Write, simulate a restart, verify state restored from the AOF
│   │   └── snapshot.test.ts     # SAVE end-to-end + AOF-vs-snapshot precedence across a simulated restart
│   └── benchmark/
│       └── .gitkeep             # Scripts comparing this server's throughput/latency to real Redis
├── ARCHITECTURE.md
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.mjs
├── .prettierrc.json
├── .prettierignore
└── .gitignore
```

## 4. Data flow (in words)

1. **Client → TCP socket**: a client opens a TCP connection to the
   server's listening port. The TCP server accepts it and creates a
   per-connection state object (buffer, subscribed channels, etc.).
2. **TCP socket → RESP parser**: raw bytes arriving on the socket are
   fed into that connection's RESP parser instance, which buffers
   partial input and yields complete, parsed commands (arrays of bulk
   strings) as they become available.
3. **RESP parser → command dispatcher**: each parsed command is handed
   to the dispatcher, which resolves the command name to a handler,
   checks argument count/shape, and rejects malformed commands with a
   RESP error before touching any state.
4. **Command dispatcher → data store**: a valid command's handler reads
   and/or mutates the in-memory data store (and, for write commands,
   appends the command to the AOF and consults the expiry engine as
   needed).
5. **Data store → RESP serializer**: the handler's return value (a
   value, status, count, error, etc.) is handed to the serializer, which
   encodes it as a RESP reply (simple string, bulk string, integer,
   array, or error).
6. **RESP serializer → client**: the encoded bytes are written back out
   on the same socket the command arrived on. For pub/sub, messages are
   pushed to subscriber sockets outside of this normal request/response
   cycle, using the same serializer.

## 5. Git branching strategy

- `main` is protected: no direct commits except the initial scaffolding
  commit that established this document and repo skeleton. From here on,
  all work happens on feature branches and merges via PR.
- One feature branch per component/chunk of work, branched from `main`.
- Branch naming convention: `feature/<short-component-name>`, e.g.
  `feature/tcp-server`, `feature/resp-parser`, `feature/data-store`,
  `feature/command-dispatcher`, `feature/aof-persistence`,
  `feature/snapshotting`, `feature/pubsub`, `feature/expiry-engine`.
  Non-feature work uses matching prefixes: `fix/<name>`, `chore/<name>`,
  `docs/<name>`.
- A PR is required to merge any branch into `main`. Each PR should map to
  one logical chunk of the checklist below (section 7), so history stays
  readable and revertable.
- Commits within a branch follow the same "one logical change per
  commit" convention used for the rest of the project.

## 6. Testing strategy

- **Unit tests**: one test file per module, mirroring `src/` inside
  `test/unit/` (e.g. `test/unit/protocol/respParser.test.ts`). These test
  pure logic in isolation — no real sockets, no real filesystem where
  avoidable (mock/in-memory instead).
- **Integration tests**: live in `test/integration/`. These start a real
  instance of the server on an ephemeral port and talk to it over an
  actual TCP socket (a small test client, or raw `net.connect`),
  asserting on real RESP responses end-to-end. This is what catches
  protocol-framing bugs unit tests can't see.
- **Benchmark scripts**: live in `test/benchmark/`. These drive both this
  server and a real Redis instance (if available locally) with the same
  workload and report throughput/latency side by side, so performance
  claims in the README are backed by numbers rather than vibes. These
  are scripts run on demand, not part of the normal CI test run.
- Test runner: [Vitest](https://vitest.dev/) (fast, native TS support,
  works equally well for unit and integration-style tests).
- A chunk isn't considered done until its tests pass — this applies to
  every future chunk, not just this scaffolding one.

## 7. Checklist / roadmap

This is the single source of truth for project progress. Update it after
every chunk. Nothing below is implemented yet except where marked.

### Foundation

- [x] Repo scaffolding, `ARCHITECTURE.md`, tooling config (this chunk)
- [x] TCP server skeleton (`feature/tcp-server`) — listens on a configurable
      port (`PORT` env var, default 6379), accepts concurrent connections,
      cleans up on client disconnect, and shuts down gracefully on
      SIGINT/SIGTERM. Originally echo-only; now parses RESP and dispatches
      commands instead (see `feature/core-commands` below)
- [x] RESP protocol parser (`feature/resp-protocol`) — streaming decoder
      for simple strings, errors, integers, bulk strings (incl. null),
      and arrays (incl. null); buffers correctly across fragmented/partial
      TCP reads and handles multiple pipelined values in one chunk
- [x] RESP protocol serializer (`feature/resp-protocol`) — encodes all of
      the above back to wire format
- [x] In-memory data store core (`feature/core-commands`) — `DataStore`
      class, plain `Map` under the hood, decoupled from the dispatcher.
      Supports string get/set/del/exists; SET records an absolute
      `expiresAt` timestamp but nothing enforces it yet (expiry engine,
      still below, is a later chunk)
- [x] Command dispatcher + command table (`feature/core-commands`) — RESP
      parser/serializer wired into the TCP server; `dispatch()` validates
      request shape and arity, looks up the command table, and returns a
      RespValue reply. First commands wired: PING, SET (EX/PX only), GET,
      DEL, EXISTS

### Command groups

- [ ] String commands (GET, SET, APPEND, INCR/DECR, ...) — GET and SET
      (EX/PX only) done in `feature/core-commands`; APPEND/INCR/DECR/other
      SET options (NX, XX, ...) still pending
- [ ] Key commands (DEL, EXISTS, EXPIRE, TTL, KEYS, TYPE, ...) — DEL and
      EXISTS done in `feature/core-commands`; EXPIRE, PEXPIRE, TTL, PTTL,
      and PERSIST done in `feature/expiry` (see the Expiry engine entry
      below — `expiresAt` is now fully enforced); KEYS/TYPE still pending
- [x] Hash commands (HSET, HGET, HDEL, HGETALL, HEXISTS, HLEN) — all six
      done in `feature/hashes`, backed by a new `HashEntry` type in
      `DataStore` (a `Map<string, string>` per key) alongside
      `StringEntry`/`ListEntry`. HSET returns the count of _newly added_
      fields, not total fields touched, matching real Redis. A key is
      removed once HDEL empties its hash, matching the List/LPOP
      precedent. HINCRBY/HMGET/HKEYS/HVALS/etc. still pending. Reuses the
      same WRONGTYPE mechanism as Lists (dispatch()'s centralized
      try/catch on `WrongTypeError`) — no per-command duplication
- [x] List commands (LPUSH, RPUSH, LPOP, RPOP, LRANGE, LLEN, ...) — all six
      done in `feature/lists`, backed by a new `ListEntry` type in
      `DataStore` alongside `StringEntry`. LPOP/RPOP don't support the
      optional COUNT argument yet; LINSERT/LREM/LSET/LTRIM/etc. still
      pending. A key is removed once LPOP/RPOP empties its list, matching
      real Redis. Operating on a key of the wrong type (e.g. LPUSH on a
      string, or GET on a list) returns a real-Redis-style `WRONGTYPE`
      error instead of silently coercing or crashing
- [x] Set commands (SADD, SREM, SMEMBERS, SISMEMBER, SCARD) — all five
      done in `feature/sets`, backed by a new `SetEntry` type in
      `DataStore` (a `Set<string>` per key) alongside
      `StringEntry`/`ListEntry`/`HashEntry`. SADD returns the count of
      _newly added_ members, matching the HSET precedent. A key is
      removed once SREM empties its set. SINTER/SUNION/SDIFF/SPOP/etc.
      still pending. Reuses the same centralized WRONGTYPE mechanism as
      Lists and Hashes unchanged — third data type in a row that needed
      zero changes to `dispatch()`'s error handling
- [ ] Sorted set commands (ZADD, ZRANGE, ZSCORE, ...)

### Core engine features

- [x] Expiry engine (passive + active expiry) — done in `feature/expiry`.
      Passive: `DataStore.getLive()` lazily deletes and treats a key as
      absent the instant anything looks it up past its TTL, so every
      read path (GET, EXISTS, DEL, LRANGE, HGET, SMEMBERS, ...) respects
      expiry with zero help from a background process. Active:
      `DataStore.sweepExpired(sampleSize)`, called on an interval by the
      new `ExpiryEngine` class (`src/expiry/expiryEngine.ts`, wired into
      `src/index.ts`) — bounded work per tick, sampling only keys
      tracked in a side-set (`keysWithExpiry`) rather than scanning the
      whole keyspace, the same idea real Redis's active-expire cycle
      uses (simplified: insertion-order sampling here, not true
      randomness). New commands: EXPIRE, PEXPIRE, TTL, PTTL, PERSIST —
      generic/type-agnostic, work on any key type
- [ ] Pub/sub (SUBSCRIBE, UNSUBSCRIBE, PUBLISH)
- [ ] Transactions (MULTI/EXEC/DISCARD/WATCH)
- [x] AOF persistence (write log + startup replay) — done in
      `feature/persistence-aof`. `AofLog` (`src/persistence/aof.ts`)
      appends every successful write command to disk as its original
      RESP-encoded bytes (an array of bulk strings — the exact wire
      format a client sent), and replays them through the same
      `dispatch()` used for live traffic before the server starts
      accepting connections. Which commands count as "write" is a new
      `isWrite` flag on each `CommandDefinition` in the dispatcher,
      exposed as `isWriteCommand()`; read-only commands and failed
      writes (e.g. WRONGTYPE) are never appended. AOF path is
      configurable via the `AOF_PATH` env var (default
      `./data/appendonly.aof`). A corrupted or truncated tail is
      logged and replay stops there rather than crashing or losing the
      valid commands before it — reuses a newly-exported single-value
      parse function from `respParser.ts` (`parseValue`) rather than
      RespParser's streaming `push()`, since `push()` discards
      already-parsed values when a later one is malformed, which is
      wrong for replay. Known simplifications vs real Redis: synchronous
      per-write fs append (no configurable fsync policy), no AOF
      rewrite/compaction, and a relative EXPIRE/PEXPIRE replays as a
      relative command, so its TTL clock restarts from replay time
      rather than preserving the original absolute expiry
- [x] Snapshotting (dump/load full dataset) — done in `feature/persistence-snapshot`.
- [x] Snapshot save/load: `Snapshot` (`src/persistence/snapshot.ts`) serializes the whole
      `DataStore` to a JSON file via new `dumpAll()`/`restoreAll()` methods on `DataStore`
      (Map/Set converted to plain arrays; already-expired keys are skipped on dump). New `SAVE`
      command triggers it — `dispatch()` gained an optional third `context` parameter
      (`DispatchContext`, `{ save?: (store) => void }`) purely for this; existing handlers didn't
      need to change, since a function with fewer declared parameters than a type's signature is
      still assignable to it in TS. `SAVE` is `isWrite: false` — it doesn't mutate the store, so
      it's never appended to the AOF itself.
- [x] AOF-vs-snapshot precedence at startup: `loadPersistedState()` (same file) loads the
      snapshot only if it exists and the AOF either doesn't exist or is strictly older than the
      snapshot (`aofMtime < snapshotMtime`); otherwise it replays the AOF if that exists; if
      neither exists, the store just starts empty. On a tie (equal mtimes) the AOF wins. Exactly
      one of the two is ever used, never both. This is a simplified single-mtime comparison, not
      real Redis's separate persistence-mode configuration.
- [x] Background save trigger: new `SnapshotScheduler` (`src/persistence/snapshotScheduler.ts`),
      mirroring `ExpiryEngine`'s start/stop/unref'd-interval shape. Two independent, configurable
      triggers — after N writes (`SNAPSHOT_WRITE_THRESHOLD`, default 100) or every M ms
      (`SNAPSHOT_INTERVAL_MS`, default 60s), whichever comes first — both just call the same
      synchronous `Snapshot.save()`. Explicitly **not** a reimplementation of real Redis's RDB
      save-point rules (multiple combined `save <seconds> <changes>` points, backed by a forked
      copy-on-write child process so saving never blocks the event loop) — this blocks the event
      loop for the duration of the JSON write, fine at this project's target dataset sizes and
      explicitly out of scope to fix (see non-goals). New env vars: `SNAPSHOT_PATH` (default
      `./data/dump.snapshot`), `SNAPSHOT_WRITE_THRESHOLD`, `SNAPSHOT_INTERVAL_MS`.

### Stretch / later

- [ ] Simple leader-follower replication demo (unscheduled, may be cut)
- [ ] CLI/frontend client for interacting with the server
- [ ] CI pipeline (lint, typecheck, unit + integration tests on push)
- [ ] Deployment (containerization, hosting)

### Docs & quality (ongoing)

- [ ] Keep this checklist current after every chunk
- [ ] Real `README.md` once there are real features to describe
- [ ] Benchmark scripts vs. real Redis, results documented
