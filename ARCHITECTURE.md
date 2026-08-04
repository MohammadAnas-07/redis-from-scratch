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
  write command so state can be replayed on restart. Snapshotting:
  periodic point-in-time dump of the whole dataset (our own format, not
  RDB-compatible) so AOF replay on startup can be bounded/fast.
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
│   │   ├── respParser.ts       # Streaming RESP decoder: bytes in, parsed commands out
│   │   └── respSerializer.ts   # Encodes command results/errors into RESP wire format
│   ├── store/
│   │   └── dataStore.ts        # In-memory key/value engine (strings, hashes, lists, sets, sorted sets)
│   ├── commands/
│   │   └── dispatcher.ts       # Command table lookup, arity/arg validation, handler invocation
│   ├── persistence/
│   │   ├── aof.ts              # Append-only write log + replay on startup
│   │   └── snapshot.ts         # Point-in-time full-dataset snapshot dump/load
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
│   ├── unit/
│   │   └── .gitkeep             # Per-module unit tests (mirrors src/ structure)
│   ├── integration/
│   │   └── .gitkeep             # Spins up the real server, talks to it over a real socket
│   └── benchmark/
│       └── .gitkeep             # Scripts comparing this server's throughput/latency to real Redis
├── ARCHITECTURE.md
├── README.md
├── package.json
├── tsconfig.json
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
- [ ] TCP server skeleton (`feature/tcp-server`)
- [ ] RESP protocol parser
- [ ] RESP protocol serializer
- [ ] In-memory data store core (get/set primitives)
- [ ] Command dispatcher + command table

### Command groups

- [ ] String commands (GET, SET, APPEND, INCR/DECR, ...)
- [ ] Key commands (DEL, EXISTS, EXPIRE, TTL, KEYS, TYPE, ...)
- [ ] Hash commands (HSET, HGET, HDEL, HGETALL, ...)
- [ ] List commands (LPUSH, RPUSH, LPOP, RPOP, LRANGE, ...)
- [ ] Set commands (SADD, SREM, SMEMBERS, SINTER, ...)
- [ ] Sorted set commands (ZADD, ZRANGE, ZSCORE, ...)

### Core engine features

- [ ] Expiry engine (passive + active expiry)
- [ ] Pub/sub (SUBSCRIBE, UNSUBSCRIBE, PUBLISH)
- [ ] Transactions (MULTI/EXEC/DISCARD/WATCH)
- [ ] AOF persistence (write log + startup replay)
- [ ] Snapshotting (dump/load full dataset)

### Stretch / later

- [ ] Simple leader-follower replication demo (unscheduled, may be cut)
- [ ] CLI/frontend client for interacting with the server
- [ ] CI pipeline (lint, typecheck, unit + integration tests on push)
- [ ] Deployment (containerization, hosting)

### Docs & quality (ongoing)

- [ ] Keep this checklist current after every chunk
- [ ] Real `README.md` once there are real features to describe
- [ ] Benchmark scripts vs. real Redis, results documented
