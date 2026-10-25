// Offline contract test: the pinned odata-mcp-proxy, run over stdio with the
// real ci-api-config.json, a local stub backend and fake credentials.
// No network, no real credentials.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { declaredRequiredScopes, deriveExpectedTools, PUT_UPDATE_SETS, xsSecurity } from './helpers/config.mjs';
import { startProxy } from './helpers/mcp-stdio.mjs';
import { destinationEnv, startStub } from './helpers/stub-backend.mjs';

// Update these numbers on purpose when a tool is added to or removed from the config.
const EXPECTED_TOOL_COUNT = 223;
const EXPECTED_READ_ONLY_COUNT = 132;

const WRITE_SUFFIXES = ['_create', '_update', '_delete'];

function keyExpression(keys) {
  if (keys.length === 0) return '';
  if (keys.length === 1) return `('k1')`;
  return `(${keys.map((k, i) => `${k.name}='k${i + 1}'`).join(',')})`;
}

/** The call a test makes for a tool, and the request it expects the stub to see. */
function plan(tool) {
  const key = keyExpression(tool.keys);
  const base = `${tool.pathPrefix}/${tool.urlPath}`;
  switch (tool.kind) {
    case 'list':
      return { args: { path: '?$top=1' }, url: `${base}?$top=1` };
    case 'get':
    case 'delete':
      return { args: { path: key }, url: `${base}${key}` };
    case 'update':
      return { args: { path: key, body: { Name: 'changed' } }, url: `${base}${key}`, body: { Name: 'changed' } };
    case 'create':
      return { args: { body: { Name: 'created' } }, url: base, body: { Name: 'created' } };
    case 'nav':
      return { args: { path: `${key}?$top=1` }, url: `${base}${key}/${tool.nav}?$top=1` };
    default:
      throw new Error(`unknown tool kind ${tool.kind}`);
  }
}

function toolText(response) {
  assert.ok(response.result, `expected a JSON-RPC result, got ${JSON.stringify(response).slice(0, 300)}`);
  return response.result.content[0].text;
}

describe('ci-mcp-server contract (pinned odata-mcp-proxy, stdio, stub backend)', () => {
  let stub;
  let proxy;
  let tools;

  before(async () => {
    stub = await startStub();
    proxy = startProxy({ env: destinationEnv(stub.baseUrl) });
    const init = await proxy.initialize();
    assert.equal(init.serverInfo.name, 'ci-mcp-server');
    tools = await proxy.listTools();
  });

  after(async () => {
    await proxy?.close();
    await stub?.close();
  });

  test('tool names match the set derived from ci-api-config.json', () => {
    const expected = deriveExpectedTools().map((t) => t.name).sort();
    const actual = tools.map((t) => t.name).sort();
    assert.equal(new Set(actual).size, actual.length, 'tool names must be unique');
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, EXPECTED_TOOL_COUNT);
  });

  test('every tool sends the expected method and URL, with body and CSRF token for writes', async () => {
    const failures = [];
    for (const tool of deriveExpectedTools()) {
      const { args, url, body } = plan(tool);
      stub.reset();
      const response = await proxy.callTool(tool.name, args);
      const calls = stub.calls;
      if (response.error || response.result?.isError || calls.length !== 1) {
        failures.push(`${tool.name}: expected one backend call, got ${calls.length}; ${JSON.stringify(response).slice(0, 200)}`);
        continue;
      }
      const [call] = calls;
      if (call.method !== tool.method) failures.push(`${tool.name}: method ${call.method}, expected ${tool.method}`);
      if (decodeURIComponent(call.url) !== url) failures.push(`${tool.name}: url ${call.url}, expected ${url}`);
      if (call.authorization !== 'Bearer fake-access-token') failures.push(`${tool.name}: bearer token not forwarded`);
      if (tool.method !== 'GET') {
        if (call.csrf !== 'fake-csrf-token') failures.push(`${tool.name}: CSRF token not sent`);
        if (body !== undefined) {
          if (call.contentType !== 'application/json') failures.push(`${tool.name}: content-type ${call.contentType}`);
          if (JSON.stringify(JSON.parse(call.body)) !== JSON.stringify(body)) failures.push(`${tool.name}: body ${call.body}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  test('updates are PUT for APIProducts, RatePlans, CertificateStoreReferences and CacheResources, PATCH elsewhere', () => {
    const updates = deriveExpectedTools().filter((t) => t.kind === 'update');
    assert.ok(updates.length > 0);
    const put = updates.filter((t) => t.method === 'PUT').map((t) => t.entitySet).sort();
    assert.deepEqual(put, [...PUT_UPDATE_SETS].sort());
    assert.ok(updates.filter((t) => t.method === 'PATCH').length > 0);
    // The tool descriptions announce the method too.
    for (const update of updates) {
      const tool = tools.find((t) => t.name === update.name);
      assert.match(tool.description, new RegExp(`\\(${update.method}\\)`), `${update.name} description should name ${update.method}`);
    }
  });

  test('ProductAccessRules reaches AccessControl.svc/Rules', async () => {
    stub.reset();
    await proxy.callTool('ProductAccessRules_list', { path: '?$top=1' });
    await proxy.callTool('ProductAccessRules_get', { path: `('r1')` });
    const urls = stub.calls.map((c) => decodeURIComponent(c.url));
    assert.deepEqual(urls, [
      '/apiportal/api/1.0/AccessControl.svc/Rules?$top=1',
      `/apiportal/api/1.0/AccessControl.svc/Rules('r1')`,
    ]);
  });

  test('JmsResources lists the Queues entity set', async () => {
    stub.reset();
    await proxy.callTool('JmsResources_list', {});
    assert.deepEqual(stub.calls.map((c) => c.url), ['/api/v1/Queues']);
  });

  test('IntegrationPackages exposes its design-time artifact sets as navigation tools', async () => {
    const artifactSets = [
      'IntegrationDesigntimeArtifacts', 'ValueMappingDesigntimeArtifacts', 'MessageMappingDesigntimeArtifacts',
      'ScriptCollectionDesigntimeArtifacts', 'DataTypeDesigntimeArtifacts', 'MessageTypeDesigntimeArtifacts',
      'FaultMessageTypeDesigntimeArtifacts', 'ServiceInterfaceDesigntimeArtifacts',
    ];
    const names = tools.map((t) => t.name);
    for (const set of artifactSets) assert.ok(names.includes(`IntegrationPackages_${set}_list`), `missing IntegrationPackages_${set}_list`);
    stub.reset();
    await proxy.callTool('IntegrationPackages_IntegrationDesigntimeArtifacts_list', { path: `('Pkg1')` });
    assert.deepEqual(stub.calls.map((c) => c.url), [`/api/v1/IntegrationPackages('Pkg1')/IntegrationDesigntimeArtifacts`]);
  });

  test('list tools that fail on a tenant say so in their description', () => {
    const describe = (name) => tools.find((t) => t.name === name).description;
    // Plain list answers HTTP 501 on a Cloud Foundry tenant: the description must say so and name the way to read the data.
    const keyAddressed = {
      IntegrationDesigntimeArtifacts_list: /501.*IntegrationPackages_IntegrationDesigntimeArtifacts_list/,
      ScriptCollectionDesigntimeArtifacts_list: /501.*IntegrationPackages_ScriptCollectionDesigntimeArtifacts_list/,
      CustomTagConfigurations_list: /501.*\('CustomTags'\)\/\$value/,
      BuildAndDeployStatus_list: /501.*TaskId/,
      MessageStoreEntries_list: /501.*MessageProcessingLogs_MessageStoreEntries_list/,
      JmsBrokers_list: /501.*\('Broker1'\)/,
    };
    for (const [name, pattern] of Object.entries(keyAddressed)) {
      assert.match(describe(name), /key-addressed/, name);
      assert.match(describe(name), pattern, name);
    }
    // $top answers HTTP 501 on these sets.
    for (const name of ['NumberRanges_list', 'LogFiles_list', 'LogFileArchives_list']) {
      assert.match(describe(name), /rejects \$top.*list without it/, name);
    }
  });

  test('a binary $value round-trips byte-exactly', async () => {
    stub.reset();
    const response = await proxy.callTool('IntegrationDesigntimeArtifacts_get', {
      path: `(Id='Flow1',Version='1.0.0')/$value`,
    });
    const envelope = JSON.parse(toolText(response));
    assert.equal(envelope.contentType, 'application/zip');
    assert.equal(envelope.encoding, 'base64');
    assert.equal(envelope.size, stub.binary.length);
    assert.ok(Buffer.from(envelope.data, 'base64').equals(stub.binary), 'decoded bytes differ from the bytes the backend sent');
    assert.deepEqual(
      stub.calls.map((c) => decodeURIComponent(c.url)),
      [`/api/v1/IntegrationDesigntimeArtifacts(Id='Flow1',Version='1.0.0')/$value`],
    );
  });

  test('a path with dot segments is refused before it reaches the backend', async () => {
    stub.reset();
    const response = await proxy.callTool('APIProxies_list', { path: '/../Applications' });
    assert.equal(response.result?.isError, true);
    assert.equal(stub.calls.length, 0);
  });

  test('stdout carries only JSON-RPC, including during write calls', () => {
    assert.ok(proxy.stdoutLines.length > 0);
    const bad = proxy.stdoutLines.filter((line) => {
      try {
        const message = JSON.parse(line);
        return message?.jsonrpc !== '2.0';
      } catch {
        return true;
      }
    });
    assert.deepEqual(bad.slice(0, 3), []);
  });

  test('the proxy fetched its token with the destination credentials', () => {
    assert.ok(stub.tokenRequests.length > 0);
    assert.ok(stub.tokenRequests.every((t) => t.authorized));
  });
});

describe('ci-mcp-server accepted MCP_READ_ONLY startup values', () => {
  for (const value of [undefined, '', 'true', 'TRUE', 'tRuE', '1', 'false', 'FALSE', 'fAlSe', '0']) {
    test(`MCP_READ_ONLY=${value === undefined ? '<unset>' : JSON.stringify(value)} preserves the documented write policy`, async () => {
      const stub = await startStub();
      const readOnly = ['true', '1'].includes(value?.toLowerCase());
      const proxy = startProxy({ env: { ...destinationEnv(stub.baseUrl), ...(value === undefined ? {} : { MCP_READ_ONLY: value }) } });
      try {
        await proxy.initialize();
        const tools = await proxy.listTools();
        assert.equal(tools.length, readOnly ? EXPECTED_READ_ONLY_COUNT : EXPECTED_TOOL_COUNT);
        const response = await proxy.callTool('IntegrationPackages_create', { body: { Id: 'startup-value-test' } });
        assert.equal(Boolean(response.error || response.result?.isError), readOnly);
        assert.deepEqual(stub.calls.map((call) => call.method), readOnly ? [] : ['POST']);
      } finally {
        await proxy.close();
        await stub.close();
      }
    });
  }
});

describe('ci-mcp-server read-only mode (MCP_READ_ONLY=true)', () => {
  let stub;
  let proxy;
  let tools;

  before(async () => {
    stub = await startStub();
    proxy = startProxy({ env: destinationEnv(stub.baseUrl), readOnly: true });
    await proxy.initialize();
    tools = await proxy.listTools();
  });

  after(async () => {
    await proxy?.close();
    await stub?.close();
  });

  test('registers exactly the read tools and no write tool', () => {
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, deriveExpectedTools({ readOnly: true }).map((t) => t.name).sort());
    assert.equal(names.length, EXPECTED_READ_ONLY_COUNT);
    assert.deepEqual(names.filter((n) => WRITE_SUFFIXES.some((s) => n.endsWith(s))), []);
  });

  test('a write tool call does not reach the backend', async () => {
    stub.reset();
    const response = await proxy.callTool('IntegrationPackages_create', { body: { Id: 'x' } });
    assert.ok(response.error || response.result?.isError, 'write tool call should fail');
    assert.equal(stub.calls.length, 0);
  });

  test('read tools still work', async () => {
    stub.reset();
    const response = await proxy.callTool('IntegrationPackages_list', { path: '?$top=1' });
    assert.ok(!response.error && !response.result?.isError);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].method, 'GET');
  });
});

describe('ci-mcp-server scope declarations', () => {
  const declared = new Set(xsSecurity.scopes.map((s) => s.name));

  test('every requiredScope in ci-api-config.json is declared in xs-security.json', () => {
    const scopes = declaredRequiredScopes();
    assert.ok(scopes.length > 0);
    const missing = scopes.filter((s) => !declared.has(`$XSAPPNAME.${s}`));
    assert.deepEqual(missing, []);
  });

  test('every role template references only declared scopes', () => {
    for (const template of xsSecurity['role-templates']) {
      for (const ref of template['scope-references']) {
        assert.ok(declared.has(ref), `${template.name} references undeclared scope ${ref}`);
      }
    }
  });

  test('a role collection description does not claim more than its scopes allow', () => {
    const templates = new Map(xsSecurity['role-templates'].map((t) => [`$XSAPPNAME.${t.name}`, t]));
    for (const collection of xsSecurity['role-collections']) {
      const scopes = collection['role-template-references'].flatMap((ref) => templates.get(ref)['scope-references']);
      if (!scopes.includes('$XSAPPNAME.write') && !scopes.includes('$XSAPPNAME.admin')) {
        assert.doesNotMatch(collection.description, /modif|write|edit|admin/i, `"${collection.name}" carries only read scopes`);
      }
    }
  });
});
