// Command table lookup, arity/argument validation, and handler invocation.
//
// Takes an already-parsed RESP request (expected to be an array of bulk
// strings, per the RESP client-command convention) and a DataStore, and
// returns the RespValue reply to send back. Knows nothing about sockets or
// buffering — that's the TCP server's job.
import { bulkString, error, integer, simpleString, type RespValue } from '../protocol/respTypes.js';
import { type DataStore } from '../store/dataStore.js';

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
};

/**
 * Dispatches one parsed RESP request against `store` and returns the
 * RespValue reply. Never throws for expected protocol/argument problems —
 * those come back as a RESP error value, exactly as a real client would see.
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

  return definition.handler(store, commandArgs);
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
