import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from './helpers/config.mjs';
import { destinationEnv } from './helpers/stub-backend.mjs';

const keyAddressed = new Set([
  'IntegrationDesigntimeArtifacts', 'ScriptCollectionDesigntimeArtifacts', 'CustomTagConfigurations',
  'BuildAndDeployStatus', 'MessageStoreEntries', 'JmsBrokers',
]);
const noTop = new Set(['NumberRanges', 'LogFiles', 'LogFileArchives']);
const privateText = 'PRIVATE_TENANT_DATA_42';

async function runSmoke({ statusFor = () => undefined, tokenStatus = 200, withIflow = false, emptyPackage = false, withProxy = false, withLog = false, invalidCollection = false, invalidZip = false, failDirectToken = false } = {}) {
  const requests = [];
  const zip = Buffer.alloc(23);
  zip.writeUInt32LE(0x06054b50);
  zip.writeUInt16LE(1, 20);
  zip[22] = 0xff;
  if (invalidZip) zip.fill(0xff);
  const tokenRequests = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub.invalid');
    if (url.pathname.startsWith('/oauth/')) {
      const count = (tokenRequests.get(url.pathname) ?? 0) + 1;
      tokenRequests.set(url.pathname, count);
      const status = failDirectToken && count > 1 ? 401 : tokenStatus;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { access_token: 'fake-access-token', expires_in: 3600 } : { error: privateText }));
      return;
    }
    requests.push({ method: req.method, path: url.pathname, query: url.search, top: url.searchParams.get('$top') });
    const set = url.pathname.split('/').at(-1);
    const status = statusFor(url) ?? ((keyAddressed.has(set) && !url.pathname.includes('(')) || (noTop.has(set) && url.searchParams.has('$top')) ? 501 : 200);
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: { value: privateText } } }));
      return;
    }
    if (url.pathname.endsWith('/$value')) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.write(zip.subarray(0, 7));
      res.end(zip.subarray(7));
      return;
    }
    let items = [];
    if ((withIflow || emptyPackage) && set === 'IntegrationPackages') items = [{ Id: `pkg-${privateText}` }];
    if (withIflow && url.pathname.includes('IntegrationPackages(') && set === 'IntegrationDesigntimeArtifacts') {
      items = [{ Id: `flow-${privateText}`, Version: '1.0' }];
    }
    if (withProxy && set === 'APIProxies') items = [{ name: `proxy-${privateText}` }];
    if (withLog && set === 'MessageProcessingLogs') items = [{ MessageGuid: `guid-${privateText}` }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(invalidCollection && set === 'IntegrationPackages' ? { error: privateText } : { d: { results: items } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(repoRoot, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(repoRoot, 'test-results', 'smoke-regression-'));
  const resultPath = join(dir, 'result.json');
  const env = destinationEnv(base);
  for (const prefix of ['CPI_DESTINATION', 'API_DESTINATION']) env[`${prefix}_TOKEN_URL`] = `${base}/oauth/${prefix}/${privateText}`;
  const child = spawn(process.execPath, ['test/live-smoke.mjs'], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '', ...env, LIVE_RESULTS_FILE: resultPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    const report = JSON.parse(readFileSync(resultPath, 'utf8'));
    return { code, stdout, stderr, report, requests };
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertPrivate(result) {
  assert.doesNotMatch(JSON.stringify(result.report) + result.stdout + result.stderr, new RegExp(privateText));
}

function assertFailed(result) {
  assert.equal(result.code, 1);
  assert.equal(result.report.summary.passed, false);
  assert.ok(result.report.summary.hardFailures.length > 0);
  assert.match(result.stdout, /FAIL/);
  assertPrivate(result);
}

test('live CLI uses bounded lists, documented exceptions and private byte-pair evidence', async () => {
  const result = await runSmoke({ withIflow: true });
  assert.equal(result.code, 0, JSON.stringify(result.report.summary));
  assert.equal(result.report.summary.passed, true);
  assert.match(result.stdout, /PASS/);
  assert.ok(result.requests.every((r) => r.method === 'GET'));
  const unrestricted = result.requests.filter((r) => !r.path.includes('(') && r.top === null);
  assert.ok(unrestricted.length > 0);
  assert.ok(unrestricted.every((r) => keyAddressed.has(r.path.split('/').at(-1)) || noTop.has(r.path.split('/').at(-1))));
  for (const set of ['MessageProcessingLogs', 'Policies', 'ResultsUTC']) {
    const calls = result.requests.filter((r) => r.path.endsWith(`/${set}`));
    assert.ok(calls.length > 0, set);
    assert.ok(calls.every((r) => r.top === '1'), set);
  }
  for (const set of noTop) {
    assert.deepEqual(result.requests.filter((r) => r.path.endsWith(`/${set}`)).map((r) => r.top), ['1', null], set);
  }
  for (const set of keyAddressed) {
    const entry = result.report.sweep.find((r) => r.tool === `${set}_list`);
    assert.equal(entry.plain.httpStatus, 501);
    assert.equal(entry.verdict, 'fails (known limit)');
  }
  const packageNavigation = result.report.navigation.filter((r) => r.tool?.startsWith('IntegrationPackages_'));
  assert.equal(packageNavigation.length, 8);
  assert.ok(packageNavigation.every((r) => r.ok && r.httpStatus === 200));
  const pair = result.report.valuePairs[0];
  assert.equal(pair.mcpEqualsTenantBytes, true);
  assert.equal(pair.mcpEqualsDirectGet, true);
  assert.deepEqual(pair.sizes, { mcpDecoded: 23, envelopeSize: 23, forwarder: 23, direct: 23 });
  assert.equal(pair.zip.valid, true);
  assertPrivate(result);
});

test('live CLI never publishes token-request errors', async () => {
  assertFailed(await runSmoke({ tokenStatus: 401 }));
});

for (const set of ['NumberRanges', 'LogFiles', 'LogFileArchives', ...keyAddressed]) {
  test(`live CLI fails unexpected ${set} failures instead of exempting the set`, async () => {
    assertFailed(await runSmoke({ statusFor: (url) => url.pathname.endsWith(`/${set}`) ? 503 : undefined }));
  });
}

for (const discovery of ['packages', 'iflow', 'message logs', 'API proxies']) {
  test(`live CLI fails ${discovery} discovery errors instead of skipping`, async () => {
    const result = await runSmoke({
      withIflow: true,
      statusFor: (url) => {
        if (discovery === 'packages' && url.pathname.endsWith('/IntegrationPackages') && url.searchParams.get('$top') === '20') return 503;
        if (discovery === 'iflow' && url.pathname.includes('IntegrationPackages(') && url.pathname.endsWith('/IntegrationDesigntimeArtifacts')) return 503;
        if (discovery === 'message logs' && url.pathname.endsWith('/MessageProcessingLogs')) return 503;
        if (discovery === 'API proxies' && url.pathname.endsWith('/APIProxies')) return 503;
      },
    });
    assertFailed(result);
    assert.equal(result.report.valuePairs[0]?.skipped, undefined);
  });
}

for (const emptyPackage of [false, true]) {
  test(`live CLI accepts successful empty ${emptyPackage ? 'iFlow' : 'package'} discovery`, async () => {
    const result = await runSmoke({ emptyPackage });
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.passed, true);
    assert.match(result.report.valuePairs[0].skipped, /no iFlow/);
    assertPrivate(result);
  });
}

for (const operation of ['bounded', 'plain']) {
  test(`live CLI rejects an unexpected ${operation} status even when the sibling probe works`, async () => {
    assertFailed(await runSmoke({ statusFor: (url) => {
      if (!url.pathname.endsWith('/NumberRanges')) return undefined;
      return url.searchParams.has('$top') ? (operation === 'bounded' ? 503 : 501) : (operation === 'plain' ? 503 : 200);
    } }));
  });
}

for (const probe of ['navigation', 'resources', 'broker', 'broker expansion', 'custom tags', 'message entries', 'download']) {
  test(`live CLI rejects unexpected ${probe} errors without publishing tenant text`, async () => {
    assertFailed(await runSmoke({ withIflow: true, withLog: true, statusFor: (url) => {
      if (probe === 'navigation' && url.pathname.includes('IntegrationPackages(') && url.pathname.endsWith('/ScriptCollectionDesigntimeArtifacts')) return 503;
      if (probe === 'resources' && url.pathname.endsWith('/Resources')) return 503;
      if (probe === 'broker' && url.pathname.includes('JmsBrokers(') && !url.searchParams.has('$expand')) return 503;
      if (probe === 'broker expansion' && url.pathname.includes('JmsBrokers(') && url.searchParams.has('$expand')) return 503;
      if (probe === 'custom tags' && url.pathname.includes('CustomTagConfigurations(')) return 503;
      if (probe === 'message entries' && url.pathname.includes('MessageProcessingLogs(')) return 503;
      if (probe === 'download' && url.pathname.includes('IntegrationDesigntimeArtifacts(')) return 503;
    } }));
  });
}

for (const option of ['invalidCollection', 'invalidZip', 'failDirectToken']) {
  test(`live CLI reports a private failure for ${option}`, async () => {
    assertFailed(await runSmoke({ withIflow: true, [option]: true }));
  });
}

test('live CLI checks the documented missing-parameter response separately', async () => {
  const good = await runSmoke({ withProxy: true, statusFor: (url) => url.pathname.endsWith('/GetAllRevisions') && !url.searchParams.has('apiProxyName') ? 400 : undefined });
  assert.equal(good.code, 0);
  assertPrivate(good);
  const bad = await runSmoke({ withProxy: true, statusFor: (url) => url.pathname.endsWith('/GetAllRevisions') && !url.searchParams.has('apiProxyName') ? 503 : undefined });
  assertFailed(bad);
  const failedWithParameter = await runSmoke({ withProxy: true, statusFor: (url) => url.pathname.endsWith('/GetAllRevisions') ? (url.searchParams.has('apiProxyName') ? 503 : 400) : undefined });
  assertFailed(failedWithParameter);
});
