// Command table lookup, arity/argument validation, and handler invocation.
//
// Takes an already-parsed RESP request (expected to be an array of bulk
// strings, per the RESP client-command convention) and a DataStore, and
// returns the RespValue reply to send back. Knows nothing about sockets or
// buffering — that's the TCP server's job.
import {
  array,
  bulkString,
  error,
  integer,
  simpleString,
  type RespValue,
} from '../protocol/respTypes.js';
import { type DataStore, WrongTypeError } from '../store/dataStore.js';

type CommandHandler = (store: DataStore, args: string[]) => RespValue;

interface CommandDefinition {
  /** Minimum number of arguments *after* the command name. */
  minArgs: number;
  /** Maximum number of arguments after the command name, or null for unlimited. */
  maxArgs: number | null;
  handler: CommandHandler;
  /** Whether this command can mutate the store — determines what gets appended to the AOF. */
  isWrite: boolean;
}

const COMMANDS: Record<string, CommandDefinition> = {
  PING: { minArgs: 0, maxArgs: 1, handler: handlePing, isWrite: false },
  SET: { minArgs: 2, maxArgs: 4, handler: handleSet, isWrite: true },
  GET: { minArgs: 1, maxArgs: 1, handler: handleGet, isWrite: false },
  DEL: { minArgs: 1, maxArgs: null, handler: handleDel, isWrite: true },
  EXISTS: { minArgs: 1, maxArgs: null, handler: handleExists, isWrite: false },
  LPUSH: { minArgs: 2, maxArgs: null, handler: handleLpush, isWrite: true },
  RPUSH: { minArgs: 2, maxArgs: null, handler: handleRpush, isWrite: true },
  LPOP: { minArgs: 1, maxArgs: 1, handler: handleLpop, isWrite: true },
  RPOP: { minArgs: 1, maxArgs: 1, handler: handleRpop, isWrite: true },
  LRANGE: { minArgs: 3, maxArgs: 3, handler: handleLrange, isWrite: false },
  LLEN: { minArgs: 1, maxArgs: 1, handler: handleLlen, isWrite: false },
  HSET: { minArgs: 3, maxArgs: null, handler: handleHset, isWrite: true },
  HGET: { minArgs: 2, maxArgs: 2, handler: handleHget, isWrite: false },
  HDEL: { minArgs: 2, maxArgs: null, handler: handleHdel, isWrite: true },
  HGETALL: { minArgs: 1, maxArgs: 1, handler: handleHgetall, isWrite: false },
  HEXISTS: { minArgs: 2, maxArgs: 2, handler: handleHexists, isWrite: false },
  HLEN: { minArgs: 1, maxArgs: 1, handler: handleHlen, isWrite: false },
  SADD: { minArgs: 2, maxArgs: null, handler: handleSadd, isWrite: true },
  SREM: { minArgs: 2, maxArgs: null, handler: handleSrem, isWrite: true },
  SMEMBERS: { minArgs: 1, maxArgs: 1, handler: handleSmembers, isWrite: false },
  SISMEMBER: { minArgs: 2, maxArgs: 2, handler: handleSismember, isWrite: false },
  SCARD: { minArgs: 1, maxArgs: 1, handler: handleScard, isWrite: false },
  EXPIRE: { minArgs: 2, maxArgs: 2, handler: handleExpire, isWrite: true },
  PEXPIRE: { minArgs: 2, maxArgs: 2, handler: handlePexpire, isWrite: true },
  TTL: { minArgs: 1, maxArgs: 1, handler: handleTtl, isWrite: false },
  PTTL: { minArgs: 1, maxArgs: 1, handler: handlePttl, isWrite: false },
  PERSIST: { minArgs: 1, maxArgs: 1, handler: handlePersist, isWrite: true },
};

/**
 * Dispatches one parsed RESP request against `store` and returns the
 * RespValue reply. Never throws for expected protocol/argument/type
 * problems — those come back as a RESP error value, exactly as a real
 * client would see (including WRONGTYPE, when a handler hits a key that
 * holds a different data type).
 */
export function dispatch(store: DataStore, request: RespValue): RespValue {
  const args = toCommandArgs(request);
  if (args === null) {
    return error('ERR Protocol error: expected a request as an array of bulk strings');
  }

  const commandName = args[0];
  if (commandName === undefined) {
    return error('ERR empty command');
  }

  const definition = COMMANDS[commandName.toUpperCase()];
  if (!definition) {
    return error(`ERR unknown command '${commandName}'`);
  }

  const commandArgs = args.slice(1);
  if (
    commandArgs.length < definition.minArgs ||
    (definition.maxArgs !== null && commandArgs.length > definition.maxArgs)
  ) {
    return error(`ERR wrong number of arguments for '${commandName.toLowerCase()}' command`);
  }

  try {
    return definition.handler(store, commandArgs);
  } catch (err) {
    if (err instanceof WrongTypeError) {
      return error(err.message);
    }
    throw err; // an unexpected bug, not a normal command-level error — don't hide it
  }
}

/**
 * Whether `request` names a write command (one that can mutate the
 * store) — used by the AOF wiring in index.ts to decide what to persist.
 * Returns false for anything malformed or unrecognized; only a request
 * that dispatch() would actually route to a write handler counts.
 */
export function isWriteCommand(request: RespValue): boolean {
  const args = toCommandArgs(request);
  const commandName = args?.[0];
  if (commandName === undefined) return false;
  return COMMANDS[commandName.toUpperCase()]?.isWrite ?? false;
}

/** Extracts command name + arguments as plain strings, or null if the shape is invalid. */
function toCommandArgs(request: RespValue): string[] | null {
  if (request.type !== 'array' || request.value === null) {
    return null;
  }

  const args: string[] = [];
  for (const item of request.value) {
    if (item.type !== 'bulk' || item.value === null) {
      return null;
    }
    args.push(item.value);
  }
  return args;
}

function handlePing(_store: DataStore, args: string[]): RespValue {
  const message = args[0];
  return message === undefined ? simpleString('PONG') : bulkString(message);
}

const SET_EXPIRE_OPTIONS = new Set(['EX', 'PX']);
const INTEGER_RE = /^-?\d+$/;

function handleSet(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  const value = args[1];
  // The dispatcher already enforces SET's arity (minArgs: 2), so these are
  // always present at runtime; the checks satisfy noUncheckedIndexedAccess.
  if (key === undefined || value === undefined) {
    return error("ERR wrong number of arguments for 'set' command");
  }

  const rest = args.slice(2);
  let expiresAt: number | null = null;
  if (rest.length > 0) {
    if (rest.length !== 2) {
      return error('ERR syntax error');
    }

    const option = rest[0];
    const rawAmount = rest[1];
    if (option === undefined || rawAmount === undefined) {
      return error('ERR syntax error');
    }

    const optionName = option.toUpperCase();
    if (!SET_EXPIRE_OPTIONS.has(optionName)) {
      return error('ERR syntax error');
    }

    if (!INTEGER_RE.test(rawAmount)) {
      return error('ERR value is not an integer or out of range');
    }
    const amount = Number(rawAmount);
    if (amount <= 0) {
      return error(`ERR invalid expire time in 'set' command`);
    }

    expiresAt = optionName === 'EX' ? Date.now() + amount * 1000 : Date.now() + amount;
  }

  store.set(key, value, expiresAt);
  return simpleString('OK');
}

function handleGet(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'get' command");
  }
  return bulkString(store.get(key));
}

function handleDel(store: DataStore, args: string[]): RespValue {
  return integer(store.del(args));
}

function handleExists(store: DataStore, args: string[]): RespValue {
  return integer(store.exists(args));
}

function handleLpush(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'lpush' command");
  }
  return integer(store.lpush(key, args.slice(1)));
}

function handleRpush(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'rpush' command");
  }
  return integer(store.rpush(key, args.slice(1)));
}

function handleLpop(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'lpop' command");
  }
  return bulkString(store.lpop(key));
}

function handleRpop(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'rpop' command");
  }
  return bulkString(store.rpop(key));
}

function handleLrange(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  const rawStart = args[1];
  const rawStop = args[2];
  if (key === undefined || rawStart === undefined || rawStop === undefined) {
    return error("ERR wrong number of arguments for 'lrange' command");
  }
  if (!INTEGER_RE.test(rawStart) || !INTEGER_RE.test(rawStop)) {
    return error('ERR value is not an integer or out of range');
  }

  const values = store.lrange(key, Number(rawStart), Number(rawStop));
  return array(values.map((value) => bulkString(value)));
}

function handleLlen(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'llen' command");
  }
  return integer(store.llen(key));
}

function handleHset(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'hset' command");
  }

  const rest = args.slice(1);
  if (rest.length === 0 || rest.length % 2 !== 0) {
    return error("ERR wrong number of arguments for 'hset' command");
  }

  const fields: Array<[string, string]> = [];
  for (let i = 0; i < rest.length; i += 2) {
    const field = rest[i];
    const value = rest[i + 1];
    if (field === undefined || value === undefined) {
      return error("ERR wrong number of arguments for 'hset' command");
    }
    fields.push([field, value]);
  }

  return integer(store.hset(key, fields));
}

function handleHget(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  const field = args[1];
  if (key === undefined || field === undefined) {
    return error("ERR wrong number of arguments for 'hget' command");
  }
  return bulkString(store.hget(key, field));
}

function handleHdel(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'hdel' command");
  }
  return integer(store.hdel(key, args.slice(1)));
}

function handleHgetall(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'hgetall' command");
  }

  const flat: RespValue[] = [];
  for (const [field, value] of store.hgetall(key)) {
    flat.push(bulkString(field), bulkString(value));
  }
  return array(flat);
}

function handleHexists(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  const field = args[1];
  if (key === undefined || field === undefined) {
    return error("ERR wrong number of arguments for 'hexists' command");
  }
  return integer(store.hexists(key, field) ? 1 : 0);
}

function handleHlen(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'hlen' command");
  }
  return integer(store.hlen(key));
}

function handleSadd(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'sadd' command");
  }
  return integer(store.sadd(key, args.slice(1)));
}

function handleSrem(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'srem' command");
  }
  return integer(store.srem(key, args.slice(1)));
}

function handleSmembers(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'smembers' command");
  }
  return array(store.smembers(key).map((member) => bulkString(member)));
}

function handleSismember(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  const member = args[1];
  if (key === undefined || member === undefined) {
    return error("ERR wrong number of arguments for 'sismember' command");
  }
  return integer(store.sismember(key, member) ? 1 : 0);
}

function handleScard(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'scard' command");
  }
  return integer(store.scard(key));
}

function handleExpire(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  const rawSeconds = args[1];
  if (key === undefined || rawSeconds === undefined) {
    return error("ERR wrong number of arguments for 'expire' command");
  }
  if (!INTEGER_RE.test(rawSeconds)) {
    return error('ERR value is not an integer or out of range');
  }

  const expiresAt = Date.now() + Number(rawSeconds) * 1000;
  return integer(store.expireAt(key, expiresAt) ? 1 : 0);
}

function handlePexpire(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  const rawMillis = args[1];
  if (key === undefined || rawMillis === undefined) {
    return error("ERR wrong number of arguments for 'pexpire' command");
  }
  if (!INTEGER_RE.test(rawMillis)) {
    return error('ERR value is not an integer or out of range');
  }

  const expiresAt = Date.now() + Number(rawMillis);
  return integer(store.expireAt(key, expiresAt) ? 1 : 0);
}

function handleTtl(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'ttl' command");
  }

  const ms = store.pttl(key);
  return integer(ms < 0 ? ms : Math.round(ms / 1000));
}

function handlePttl(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'pttl' command");
  }
  return integer(store.pttl(key));
}

function handlePersist(store: DataStore, args: string[]): RespValue {
  const key = args[0];
  if (key === undefined) {
    return error("ERR wrong number of arguments for 'persist' command");
  }
  return integer(store.persist(key) ? 1 : 0);
}
