// Opt-in live smoke test: `npm run test:live`. GET only. Never part of `npm test`.
//
// Runs the pinned proxy over stdio in read-only mode (MCP_READ_ONLY=true) against
// a real tenant, behind a local forwarder that serves GET and answers 405 to any
// other method. The forwarder records status, size and a sha256 per request, so
// a result shows what the tenant answered, not only what the tool returned.
// It then sweeps the `_list` tools and compares one iFlow download (`/$value`)
// with a direct authenticated GET.
//
// Tenant settings come from environment variables only (names below). Secret
// values are never printed or written. The JSON result holds tool names, HTTP
// statuses, counts and sizes. It holds no tenant host, id or business data.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deriveExpectedTools, apiConfig, configPath, proxyCliPath, repoRoot } from './helpers/config.mjs';

const REQUIRED = ['CPI_DESTINATION', 'API_DESTINATION'].flatMap((p) => ['BASE_URL', 'TOKEN_URL', 'CLIENT_ID', 'CLIENT_SECRET'].map((s) => `${p}_${s}`));
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`test:live needs these environment variables (names only, values are never printed):\n  ${missing.join('\n  ')}\nSee "Live smoke test" in README.md.`);
  process.exit(2);
}

/** Sets that hold credentials, keys, key-value data, partner parameters or message data. Never read by the sweep. */
const SENSITIVE_SETS = new Set([
  'UserCredentials', 'OAuth2ClientCredentials', 'SecureParameters', 'KeystoreEntries', 'CertificateResources',
  'SSHKeyResources', 'CertificateUserMappings', 'CertificateStores', 'Certificates', 'KeyMapEntries',
  'KeyMapEntryValues', 'GenericKeyMapEntries', 'GenericKeyMapEntryValues', 'StringParameters', 'BinaryParameters',
  'DataStoreEntries', 'Variables', 'IdMapFromId2s', 'IdempotentRepositoryEntries',
]);
/** Observed on a Cloud Foundry tenant: a plain list answers 501. */
const KEY_ADDRESSED_SETS = new Set([
  'IntegrationDesigntimeArtifacts', 'ScriptCollectionDesigntimeArtifacts', 'CustomTagConfigurations',
  'BuildAndDeployStatus', 'MessageStoreEntries', 'JmsBrokers',
]);
/** Observed on a Cloud Foundry tenant: a plain list works and `$top` answers 501. */
const NO_TOP_SETS = new Set(['NumberRanges', 'LogFiles', 'LogFileArchives']);

const results = {
  tool: 'ci-mcp-server test:live',
  startedAt: new Date().toISOString(),
  node: process.version,
  proxyVersion: JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'odata-mcp-proxy', 'package.json'), 'utf8')).version,
  tenant: '<tenant-host>',
  readOnlyMode: true,
  tools: {},
  forwarder: { nonGetRefused: 0, requests: 0 },
  sweep: [],
  navigation: [],
  keyedProbes: [],
  valuePairs: [],
  summary: {},
};
const hardFailures = [];
const fail = (message) => hardFailures.push(message);

// ---------------------------------------------------------------- forwarders
const observed = []; // one record per request that reached the tenant, in order
function startForwarder(baseUrlEnv) {
  const base = process.env[baseUrlEnv].replace(/\/+$/, '');
  const server = createServer(async (req, res) => {
    results.forwarder.requests += 1;
    if (req.method !== 'GET') {
      results.forwarder.nonGetRefused += 1;
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    try {
      const upstream = await tenantGet(`${base}${req.url}`, { authorization: req.headers.authorization, accept: req.headers.accept ?? 'application/json' });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      observed.push({ status: upstream.status, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
      const headers = {};
      const contentType = upstream.headers.get('content-type');
      if (contentType) headers['content-type'] = contentType;
      res.writeHead(upstream.status, headers).end(bytes);
    } catch (error) {
      observed.push({ status: 0, bytes: Buffer.alloc(0), sha256: '', error: String(error?.message ?? error).slice(0, 120) });
      res.writeHead(502).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

/** The only way this script reaches a tenant API: a GET. */
function tenantGet(url, headers) {
  return fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(60_000) });
}

async function fetchToken(prefix) {
  const basic = Buffer.from(`${process.env[`${prefix}_CLIENT_ID`]}:${process.env[`${prefix}_CLIENT_SECRET`]}`).toString('base64');
  const response = await fetch(process.env[`${prefix}_TOKEN_URL`], {
    method: 'POST', // OAuth token request, not a tenant API call
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${basic}` },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`token request for ${prefix} failed with HTTP ${response.status}`);
  return (await response.json()).access_token;
}

// ---------------------------------------------------------------- MCP client
function startProxy(env) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-mcp-live-'));
  const child = spawn(process.execPath, [proxyCliPath, '--config', configPath], {
    cwd,
    env: { PATH: process.env.PATH ?? '', MCP_TRANSPORT: 'stdio', MCP_READ_ONLY: 'true', ...env },
    stdio: ['pipe', 'pipe', 'ignore'], // stderr is dropped on purpose: no log line can leak into the result
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } catch {
        // ignore non-JSON lines
      }
    }
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    request,
    async init() {
      await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ci-mcp-server-live-smoke', version: '0.0.0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async close() {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/**
 * Call a tool and pair the answer with what the tenant really sent.
 * Calls are sequential, so the forwarder records added during the call belong to it.
 */
async function callTool(proxy, name, args) {
  const before = observed.length;
  const response = await proxy.request('tools/call', { name, arguments: args });
  const upstream = observed.slice(before);
  const last = upstream.at(-1);
  const isError = Boolean(response.error || response.result?.isError);
  const text = response.result?.content?.[0]?.text ?? response.error?.message ?? '';
  let data;
  if (!isError) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  return {
    ok: !isError,
    httpStatus: last?.status ?? null,
    error: isError ? String(text).replace(/^Error:\s*/, '').slice(0, 160) : undefined,
    items: Array.isArray(data?.d?.results) ? data.d.results.length : undefined,
    data,
    upstream: last,
  };
}
const publicView = ({ ok, httpStatus, error, items }) => ({ ok, httpStatus, ...(error ? { error } : {}), ...(items !== undefined ? { items } : {}) });

// ---------------------------------------------------------------- zip helper
/** Entry names and CRC-32 values from a zip's central directory. */
function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) return undefined;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    entries.set(bytes.toString('utf8', offset + 46, offset + 46 + nameLength), bytes.readUInt32LE(offset + 16));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------- run
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cpiForwarder = await startForwarder('CPI_DESTINATION_BASE_URL');
const apiForwarder = await startForwarder('API_DESTINATION_BASE_URL');
const proxy = startProxy({
  ...Object.fromEntries(REQUIRED.filter((n) => n.endsWith('_TOKEN_URL') || n.endsWith('_CLIENT_ID') || n.endsWith('_CLIENT_SECRET')).map((n) => [n, process.env[n]])),
  CPI_DESTINATION_BASE_URL: cpiForwarder.url,
  API_DESTINATION_BASE_URL: apiForwarder.url,
});

try {
  await proxy.init();
  const listed = (await proxy.request('tools/list', {})).result.tools.map((t) => t.name).sort();
  results.tools = { count: listed.length };
  const expectedNames = deriveExpectedTools({ readOnly: true }).map((t) => t.name).sort();
  if (JSON.stringify(listed) !== JSON.stringify(expectedNames)) fail('tools/list differs from the read-only set derived from ci-api-config.json');
  const has = (name) => listed.includes(name);

  // ---- 1. list sweep
  const apiProxyName = { value: undefined };
  const listTools = deriveExpectedTools({ readOnly: true }).filter((t) => t.kind === 'list');
  for (const tool of listTools) {
    if (SENSITIVE_SETS.has(tool.entitySet)) {
      results.sweep.push({ tool: tool.name, skipped: 'sensitive set, never read' });
      continue;
    }
    if (tool.entitySet === 'GetAllRevisions') continue; // needs a parameter, handled below
    const entry = { tool: tool.name };
    if (KEY_ADDRESSED_SETS.has(tool.entitySet)) entry.knownLimit = 'key-addressed on CPI: a plain list may answer 501';
    if (NO_TOP_SETS.has(tool.entitySet)) entry.knownLimit = '$top is not supported';
    const plain = await callTool(proxy, tool.name, {});
    entry.plain = publicView(plain);
    if (!NO_TOP_SETS.has(tool.entitySet) && !KEY_ADDRESSED_SETS.has(tool.entitySet)) {
      const top = await callTool(proxy, tool.name, { path: '?$top=1' });
      entry.top1 = publicView(top);
      if (tool.entitySet === 'APIProxies' && top.ok) apiProxyName.value = top.data?.d?.results?.[0]?.name;
    } else if (NO_TOP_SETS.has(tool.entitySet)) {
      entry.top1 = publicView(await callTool(proxy, tool.name, { path: '?$top=1' }));
    }
    entry.verdict = plain.ok || entry.top1?.ok ? 'works' : entry.knownLimit ? 'fails (known limit)' : 'UNEXPECTED FAILURE';
    if (entry.verdict === 'UNEXPECTED FAILURE') fail(`${tool.name}: ${plain.httpStatus} ${plain.error}`);
    results.sweep.push(entry);
  }

  // GetAllRevisions needs the apiProxyName parameter (see its tool description).
  if (has('GetAllRevisions_list')) {
    if (apiProxyName.value) {
      const called = await callTool(proxy, 'GetAllRevisions_list', { path: `?apiProxyName='${apiProxyName.value}'` });
      const bare = await callTool(proxy, 'GetAllRevisions_list', { path: '?$top=1' });
      results.sweep.push({ tool: 'GetAllRevisions_list', withApiProxyName: publicView(called), withoutParameter: publicView(bare), verdict: called.ok ? 'works with apiProxyName' : 'UNEXPECTED FAILURE' });
      if (!called.ok) fail(`GetAllRevisions_list with apiProxyName: ${called.httpStatus} ${called.error}`);
    } else {
      results.sweep.push({ tool: 'GetAllRevisions_list', skipped: 'no API proxy on the tenant to name' });
    }
  }

  // ---- 2. IntegrationPackages navigation and iFlow discovery
  const packages = await callTool(proxy, 'IntegrationPackages_list', { path: '?$top=20' });
  const packageIds = (packages.data?.d?.results ?? []).map((p) => p.Id).filter(Boolean);
  const packageNavTools = listed.filter((n) => n.startsWith('IntegrationPackages_') && n.endsWith('_list') && n !== 'IntegrationPackages_list');
  results.navigation.push({ check: 'IntegrationPackages navigation tools registered', count: packageNavTools.length, tools: packageNavTools });
  let iflow;
  for (const id of packageIds) {
    // The key-addressed path works with or without navigation tools, so discovery does not depend on them.
    const viaGet = await callTool(proxy, 'IntegrationPackages_get', { path: `('${id}')/IntegrationDesigntimeArtifacts` });
    const first = viaGet.data?.d?.results?.[0];
    if (!iflow && first) iflow = { id: first.Id, version: first.Version, packageId: id };
    if (iflow) break;
  }
  const probePackage = iflow?.packageId ?? packageIds[0];
  if (probePackage) {
    for (const name of packageNavTools) {
      const called = await callTool(proxy, name, { path: `('${probePackage}')` });
      results.navigation.push({ tool: name, ...publicView(called) });
      if (!called.ok) fail(`${name}: ${called.httpStatus} ${called.error}`);
    }
  }
  if (iflow && has('IntegrationDesigntimeArtifacts_Resources_list')) {
    const called = await callTool(proxy, 'IntegrationDesigntimeArtifacts_Resources_list', { path: `(Id='${iflow.id}',Version='${iflow.version}')` });
    results.navigation.push({ tool: 'IntegrationDesigntimeArtifacts_Resources_list', ...publicView(called) });
    if (!called.ok) fail(`IntegrationDesigntimeArtifacts_Resources_list: ${called.httpStatus} ${called.error}`);
  }

  // ---- 3. reads that the tool descriptions point to (recorded, not failures: keys and data differ per tenant)
  if (has('JmsBrokers_get')) {
    const broker = await callTool(proxy, 'JmsBrokers_get', { path: `('Broker1')` });
    results.keyedProbes.push({ tool: 'JmsBrokers_get', key: 'Broker1 (the documented default key)', ...publicView(broker) });
    const expand = await callTool(proxy, 'JmsBrokers_get', { path: `('Broker1')?$expand=QueueStates` });
    results.keyedProbes.push({ tool: 'JmsBrokers_get', option: '$expand=QueueStates', ...publicView(expand) });
  }

  if (has('CustomTagConfigurations_get')) {
    const tags = await callTool(proxy, 'CustomTagConfigurations_get', { path: `('CustomTags')/$value` });
    results.keyedProbes.push({ tool: 'CustomTagConfigurations_get', option: "('CustomTags')/$value", ...publicView(tags) });
  }
  if (has('MessageProcessingLogs_MessageStoreEntries_list') && has('MessageProcessingLogs_list')) {
    const logs = await callTool(proxy, 'MessageProcessingLogs_list', { path: '?$top=1' });
    const guid = logs.data?.d?.results?.[0]?.MessageGuid;
    if (guid) {
      const entries = await callTool(proxy, 'MessageProcessingLogs_MessageStoreEntries_list', { path: `('${guid}')` });
      results.keyedProbes.push({ tool: 'MessageProcessingLogs_MessageStoreEntries_list', key: 'first message processing log', ...publicView(entries) });
    }
  }

  // ---- 4. /$value pair: MCP vs the tenant bytes the forwarder saw vs a direct authenticated GET
  if (!iflow) {
    results.valuePairs.push({ skipped: 'no iFlow found in the first 20 packages' });
  } else {
    const path = `(Id='${iflow.id}',Version='${iflow.version}')/$value`;
    const called = await callTool(proxy, 'IntegrationDesigntimeArtifacts_get', { path });
    const pair = { artifact: 'first iFlow found (id withheld)', mcp: publicView(called) };
    const envelope = called.data;
    if (called.ok && envelope?.encoding === 'base64') {
      const mcpBytes = Buffer.from(envelope.data, 'base64');
      const direct = await tenantGet(`${process.env.CPI_DESTINATION_BASE_URL.replace(/\/+$/, '')}/api/v1/IntegrationDesigntimeArtifacts${path}`, {
        authorization: `Bearer ${await fetchToken('CPI_DESTINATION')}`,
      });
      const directBytes = Buffer.from(await direct.arrayBuffer());
      const seen = called.upstream;
      pair.contentType = envelope.contentType;
      pair.sizes = { mcpDecoded: mcpBytes.length, envelopeSize: envelope.size, forwarder: seen.bytes.length, direct: directBytes.length };
      pair.directStatus = direct.status;
      pair.mcpEqualsTenantBytes = sha256(mcpBytes) === seen.sha256; // the proxy changed nothing
      pair.mcpEqualsDirectGet = sha256(mcpBytes) === sha256(directBytes);
      const a = zipEntries(mcpBytes);
      const b = zipEntries(directBytes);
      pair.zip = { valid: Boolean(a && b), entries: a?.size, sameEntryNames: Boolean(a && b && [...a.keys()].sort().join('\n') === [...b.keys()].sort().join('\n')), entriesWithDifferentCrc: a && b ? [...a].filter(([n, crc]) => b.get(n) !== crc).length : undefined };
      if (!pair.mcpEqualsTenantBytes) fail('value pair: MCP bytes differ from the bytes the tenant sent');
      if (envelope.size !== mcpBytes.length) fail('value pair: envelope size differs from decoded size');
      if (direct.status !== 200 || !pair.zip.valid || !pair.zip.sameEntryNames) fail('value pair: direct GET is not an equal-structure zip');
      pair.note = pair.mcpEqualsDirectGet
        ? 'byte-identical to the direct GET'
        : 'the tenant builds a fresh zip per request, so entries with a different CRC can differ (earlier analysis: timestamps only); the proxy is checked against the tenant bytes it received';
    } else {
      fail(`value pair: tool call failed (${called.httpStatus} ${called.error})`);
    }
    results.valuePairs.push(pair);
  }

  if (results.forwarder.nonGetRefused > 0) fail(`${results.forwarder.nonGetRefused} non-GET request(s) reached the forwarder and were refused`);
} catch (error) {
  fail(`smoke run aborted: ${String(error?.message ?? error).slice(0, 200)}`);
} finally {
  await proxy.close();
  cpiForwarder.server.close();
  apiForwarder.server.close();
}

// ---------------------------------------------------------------- report
const swept = results.sweep.filter((s) => !s.skipped);
const verdictCount = (v) => swept.filter((s) => s.verdict?.startsWith(v)).length;
results.summary = {
  listToolsSwept: swept.length,
  skippedSensitive: results.sweep.filter((s) => s.skipped?.startsWith('sensitive')).length,
  works: verdictCount('works'),
  failsKnownLimit: verdictCount('fails (known limit)'),
  unexpectedFailures: verdictCount('UNEXPECTED'),
  hardFailures,
  passed: hardFailures.length === 0,
  finishedAt: new Date().toISOString(),
};
const outFile = process.env.LIVE_RESULTS_FILE ?? join(repoRoot, 'test-results', `live-${results.startedAt.replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`);

console.log(`live smoke: ${results.tools.count ?? '?'} read tools; ${swept.length} list tools swept (${results.summary.skippedSensitive} sensitive sets skipped)`);
for (const entry of swept) {
  const view = entry.plain ?? entry.withApiProxyName;
  console.log(`  ${String(entry.verdict).padEnd(22)} ${entry.tool}  plain=${view?.httpStatus ?? '-'}${entry.top1 ? ` top1=${entry.top1.httpStatus}` : ''}`);
}
console.log(`value pair: ${JSON.stringify(results.valuePairs[0]?.zip ? { mcpEqualsTenantBytes: results.valuePairs[0].mcpEqualsTenantBytes, mcpEqualsDirectGet: results.valuePairs[0].mcpEqualsDirectGet, ...results.valuePairs[0].zip } : results.valuePairs[0])}`);
console.log(`non-GET requests refused by the forwarder: ${results.forwarder.nonGetRefused}`);
console.log(`result file: ${outFile}`);
console.log(results.summary.passed ? 'PASS' : `FAIL\n  ${hardFailures.join('\n  ')}`);
process.exit(results.summary.passed ? 0 : 1);
