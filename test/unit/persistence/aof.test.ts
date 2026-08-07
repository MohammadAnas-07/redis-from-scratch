import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AofLog } from '../../../src/persistence/aof.js';
import { RespParser } from '../../../src/protocol/respParser.js';
import { encodeResp } from '../../../src/protocol/respSerializer.js';
import { array, bulkString, type RespValue } from '../../../src/protocol/respTypes.js';

/** Builds a RESP request the way a real client would send a command. */
function cmd(...args: string[]): RespValue {
  return array(args.map((a) => bulkString(a)));
}

describe('AofLog', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aof-test-'));
    filePath = join(dir, 'appendonly.aof');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('append', () => {
    it('writes the RESP-encoded bytes for one command', () => {
      const aof = new AofLog(filePath);
      aof.append(cmd('SET', 'foo', 'bar'));

      expect(readFileSync(filePath)).toEqual(encodeResp(cmd('SET', 'foo', 'bar')));
    });

    it('creates the parent directory if it does not exist yet', () => {
      const nestedPath = join(dir, 'nested', 'deep', 'appendonly.aof');
      const aof = new AofLog(nestedPath);
      aof.append(cmd('SET', 'foo', 'bar'));
      expect(existsSync(nestedPath)).toBe(true);
    });

    it('appends multiple commands sequentially, without overwriting earlier ones', () => {
      const aof = new AofLog(filePath);
      aof.append(cmd('SET', 'a', '1'));
      aof.append(cmd('SET', 'b', '2'));

      const values = new RespParser().push(readFileSync(filePath));
      expect(values).toEqual([cmd('SET', 'a', '1'), cmd('SET', 'b', '2')]);
    });
  });

  describe('replay', () => {
    it('is a no-op when the file does not exist', () => {
      const aof = new AofLog(filePath);
      const calls: RespValue[] = [];

      const result = aof.replay((request) => calls.push(request));

      expect(result).toEqual({ replayedCount: 0, truncated: false });
      expect(calls).toEqual([]);
    });

    it('replays every command in order', () => {
      const aof = new AofLog(filePath);
      aof.append(cmd('SET', 'a', '1'));
      aof.append(cmd('LPUSH', 'mylist', 'x'));
      aof.append(cmd('DEL', 'a'));

      const calls: RespValue[] = [];
      const result = aof.replay((request) => calls.push(request));

      expect(result).toEqual({ replayedCount: 3, truncated: false });
      expect(calls).toEqual([cmd('SET', 'a', '1'), cmd('LPUSH', 'mylist', 'x'), cmd('DEL', 'a')]);
    });

    it('stops gracefully at a corrupted command, keeping every command before it', () => {
      const aof = new AofLog(filePath);
      aof.append(cmd('SET', 'a', '1'));
      aof.append(cmd('SET', 'b', '2'));
      // Not a valid RESP type byte — parseValue throws on this.
      appendFileSync(filePath, Buffer.from('NOT-VALID-RESP\r\n'));

      const calls: RespValue[] = [];
      const result = aof.replay((request) => calls.push(request));

      expect(result).toEqual({ replayedCount: 2, truncated: true });
      expect(calls).toEqual([cmd('SET', 'a', '1'), cmd('SET', 'b', '2')]);
    });

    it('stops gracefully at a truncated trailing command', () => {
      const aof = new AofLog(filePath);
      aof.append(cmd('SET', 'a', '1'));
      // A bulk string header claiming 10 bytes of payload, but only 5 follow.
      appendFileSync(filePath, Buffer.from('$10\r\nshort'));

      const calls: RespValue[] = [];
      const result = aof.replay((request) => calls.push(request));

      expect(result).toEqual({ replayedCount: 1, truncated: true });
      expect(calls).toEqual([cmd('SET', 'a', '1')]);
    });

    it('never throws, even on a totally garbage file', () => {
      appendFileSync(filePath, Buffer.from('this is not RESP at all'));
      const aof = new AofLog(filePath);

      expect(() => aof.replay(() => {})).not.toThrow();
      expect(aof.replay(() => {})).toEqual({ replayedCount: 0, truncated: true });
    });

    it('logs a message when replay stops early due to corruption', () => {
      appendFileSync(filePath, Buffer.from('GARBAGE'));
      const messages: string[] = [];
      const aof = new AofLog(filePath, (message) => messages.push(message));

      aof.replay(() => {});

      expect(messages.some((m) => /corrupt|truncat/i.test(m))).toBe(true);
    });

    it('does not log the final success summary when replay was truncated', () => {
      appendFileSync(filePath, Buffer.from('X'));
      const messages: string[] = [];
      const aof = new AofLog(filePath, (message) => messages.push(message));

      aof.replay(() => {});

      // The success-only summary line — distinct from the per-error message,
      // which also happens to mention "restored" in its own wording.
      expect(messages.some((m) => /^AOF replay: restored \d+ command\(s\) from/.test(m))).toBe(
        false,
      );
    });
  });

  it('round-trips a realistic sequence of commands through append then replay', () => {
    const aof = new AofLog(filePath);
    const commands = [
      cmd('SET', 'foo', 'bar'),
      cmd('RPUSH', 'mylist', 'a', 'b'),
      cmd('HSET', 'myhash', 'field1', 'x'),
      cmd('SADD', 'myset', 'm1', 'm2'),
      cmd('DEL', 'foo'),
    ];
    for (const command of commands) aof.append(command);

    const replayed: RespValue[] = [];
    const result = aof.replay((request) => replayed.push(request));

    expect(result).toEqual({ replayedCount: commands.length, truncated: false });
    expect(replayed).toEqual(commands);
  });
});
