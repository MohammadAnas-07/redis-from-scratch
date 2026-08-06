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
}

const COMMANDS: Record<string, CommandDefinition> = {
  PING: { minArgs: 0, maxArgs: 1, handler: handlePing },
  SET: { minArgs: 2, maxArgs: 4, handler: handleSet },
  GET: { minArgs: 1, maxArgs: 1, handler: handleGet },
  DEL: { minArgs: 1, maxArgs: null, handler: handleDel },
  EXISTS: { minArgs: 1, maxArgs: null, handler: handleExists },
  LPUSH: { minArgs: 2, maxArgs: null, handler: handleLpush },
  RPUSH: { minArgs: 2, maxArgs: null, handler: handleRpush },
  LPOP: { minArgs: 1, maxArgs: 1, handler: handleLpop },
  RPOP: { minArgs: 1, maxArgs: 1, handler: handleRpop },
  LRANGE: { minArgs: 3, maxArgs: 3, handler: handleLrange },
  LLEN: { minArgs: 1, maxArgs: 1, handler: handleLlen },
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

    if (!/^-?\d+$/.test(rawAmount)) {
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
  if (!/^-?\d+$/.test(rawStart) || !/^-?\d+$/.test(rawStop)) {
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
