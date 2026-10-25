// Offline HTTP posture checks for the pinned proxy with the real
// ci-api-config.json: /health, the refusal to start on Cloud Foundry without
// XSUAA, 401 with an XSUAA binding, and the working-directory xs-security.json.
// The XSUAA binding is fake: its verification key and URLs are never used,
// because every check here is decided before any token is verified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { configPath, proxyCliPath, xsSecurityPath } from './helpers/config.mjs';
import { cleanEnv, makeWorkdir } from './helpers/mcp-stdio.mjs';
import { destinationEnv } from './helpers/stub-backend.mjs';

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const FAKE_XSUAA_BINDING = JSON.stringify({
  xsuaa: [
    {
      name: 'fake-xsuaa',
      label: 'xsuaa',
      credentials: {
        clientid: 'sb-fake-client',
        clientsecret: 'fake-client-secret',
        url: 'https://fake-subaccount.authentication.invalid',
        uaadomain: 'authentication.invalid',
        xsappname: 'ci-mcp-server',
        identityzone: 'fake-subaccount',
        tenantid: 'fake-tenant',
        verificationkey: 'fake-verification-key',
      },
    },
  ],
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Start the proxy over HTTP. Resolves with helpers once /health answers, or with `exited` if it quits. */
async function startHttpProxy({ env = {}, cwd = makeWorkdir() } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [proxyCliPath, '--config', configPath], {
    cwd,
    env: cleanEnv({
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ...destinationEnv('http://127.0.0.1:9'),
      ...env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;

  const ready = (async () => {
    for (let i = 0; i < 200; i += 1) {
      const code = await Promise.race([exited, new Promise((r) => setTimeout(r, 50, undefined))]);
      if (code !== undefined) return false;
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok) return true;
      } catch {
        // not listening yet
      }
    }
    throw new Error(`proxy did not become ready: ${output.slice(-800)}`);
  })();

  return {
    base,
    cwd,
    ready,
    exited,
    get output() {
      return output;
    },
    async stop() {
      child.kill('SIGTERM');
      await exited;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'posture-test', version: '0.0.0' } },
};

describe('HTTP posture of the pinned proxy', () => {
  test('local HTTP without XSUAA serves /health', async () => {
    const proxy = await startHttpProxy();
    try {
      assert.equal(await proxy.ready, true);
      const response = await fetch(`${proxy.base}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.oauth, false);
    } finally {
      await proxy.stop();
    }
  });

  test('Cloud Foundry without an XSUAA binding refuses to start', async () => {
    const proxy = await startHttpProxy({ env: { VCAP_APPLICATION: JSON.stringify({ application_uris: ['ci-mcp.invalid'] }) } });
    try {
      assert.equal(await proxy.ready, false, 'the proxy must not start listening');
      assert.notEqual(await proxy.exited, 0);
      assert.match(proxy.output, /Refusing to start: HTTP transport on Cloud Foundry without an XSUAA binding/);
    } finally {
      await proxy.stop();
    }
  });

  test('with an XSUAA binding, /mcp answers 401 without a token and /health stays open', async () => {
    const proxy = await startHttpProxy({
      env: { VCAP_APPLICATION: JSON.stringify({ application_uris: ['ci-mcp.invalid'] }), VCAP_SERVICES: FAKE_XSUAA_BINDING },
    });
    try {
      assert.equal(await proxy.ready, true, proxy.output);
      const health = await (await fetch(`${proxy.base}/health`)).json();
      assert.equal(health.oauth, true);
      const response = await fetch(`${proxy.base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initializeRequest),
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
    } finally {
      await proxy.stop();
    }
  });

  test('the working-directory xs-security.json sets the OAuth redirect allowlist', async () => {
    const register = (base, redirectUri) =>
      fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'posture-test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
      });
    const env = { VCAP_SERVICES: FAKE_XSUAA_BINDING };

    // With the repo's xs-security.json in the working directory (as `npm start` runs it).
    const withFile = makeWorkdir();
    copyFileSync(xsSecurityPath, join(withFile, 'xs-security.json'));
    const proxy = await startHttpProxy({ env, cwd: withFile });
    try {
      assert.equal(await proxy.ready, true, proxy.output);
      assert.match(proxy.output, /OAuth redirect allowlist loaded from working-directory xs-security\.json/);
      assert.equal((await register(proxy.base, CLAUDE_REDIRECT)).status, 201);
      assert.equal((await register(proxy.base, 'https://attacker.invalid/callback')).status, 400);
    } finally {
      await proxy.stop();
    }

    // Without it, the proxy falls back to its bundled list, which has no claude.ai entry.
    const fallback = await startHttpProxy({ env });
    try {
      assert.equal(await fallback.ready, true, fallback.output);
      assert.match(fallback.output, /OAuth redirect allowlist loaded from bundled xs-security\.json/);
      assert.equal((await register(fallback.base, CLAUDE_REDIRECT)).status, 400);
    } finally {
      await fallback.stop();
    }
  });
});
