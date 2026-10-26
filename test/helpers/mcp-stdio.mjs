// Spawns the pinned odata-mcp-proxy over stdio with the real ci-api-config.json
// and speaks raw JSON-RPC to it. Raw lines (not an SDK client) let a test prove
// that stdout carries nothing but JSON-RPC.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, proxyCliPath } from './config.mjs';

/**
 * Environment for a child proxy: only what the proxy needs. Nothing is
 * inherited from the caller, so a developer's own MCP_*, VCAP_* or
 * *_DESTINATION_* variables cannot change a result.
 */
export function cleanEnv(extra = {}) {
  return { PATH: process.env.PATH ?? '', ...extra };
}

/** A fresh working directory: the proxy loads default-env.json and .env from it. */
export function makeWorkdir() {
  return mkdtempSync(join(tmpdir(), 'ci-mcp-test-'));
}

export function startProxy({ env, readOnly = false } = {}) {
  const cwd = makeWorkdir();
  const child = spawn(process.execPath, [proxyCliPath, '--config', configPath], {
    cwd,
    env: cleanEnv({
      MCP_TRANSPORT: 'stdio',
      ...(readOnly ? { MCP_READ_ONLY: 'true' } : {}),
      ...env,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  let stderr = '';
  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      stdoutLines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // kept in stdoutLines; the stdout test reports it
      }
      const waiter = message && pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params, timeoutMs = 30_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id}). stderr tail: ${stderr.slice(-800)}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  return {
    stdoutLines,
    get stderr() {
      return stderr;
    },
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'ci-mcp-server-contract-test', version: '0.0.0' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return response.result;
    },
    async listTools() {
      const tools = [];
      let cursor;
      do {
        const response = await request('tools/list', cursor ? { cursor } : {});
        tools.push(...response.result.tools);
        cursor = response.result.nextCursor;
      } while (cursor);
      return tools;
    },
    /** Resolves to the JSON-RPC response (`result` or `error`). */
    callTool(name, args = {}) {
      return request('tools/call', { name, arguments: args });
    },
    async close() {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
