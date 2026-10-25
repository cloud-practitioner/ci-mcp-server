// Reads the real ci-api-config.json and xs-security.json and derives, from the
// config alone, what the pinned proxy must register and send. The derivation
// is deliberately independent from the proxy code under test.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const configPath = join(repoRoot, 'ci-api-config.json');
export const xsSecurityPath = join(repoRoot, 'xs-security.json');
export const proxyCliPath = join(repoRoot, 'node_modules', 'odata-mcp-proxy', 'dist', 'cli.js');

export const apiConfig = JSON.parse(readFileSync(configPath, 'utf8'));
export const xsSecurity = JSON.parse(readFileSync(xsSecurityPath, 'utf8'));

/** Entity sets whose update must be a full-replacement PUT (README: API Management). */
export const PUT_UPDATE_SETS = ['APIProducts', 'RatePlans', 'CertificateStoreReferences', 'CacheResources'];

/** `true`, or `{ enabled: true }`, enables an operation; anything else does not. */
export function isEnabled(op) {
  if (op === true) return true;
  return typeof op === 'object' && op !== null && op.enabled === true;
}

export function requiredScopeOf(op) {
  return typeof op === 'object' && op !== null ? op.requiredScope : undefined;
}

/**
 * One expectation per tool the config must produce.
 * `kind` is list, get, create, update, delete or nav.
 */
export function deriveExpectedTools({ readOnly = false } = {}) {
  const tools = [];
  for (const api of apiConfig.apis) {
    for (const def of api.entitySets) {
      const urlPath = def.urlPath ?? def.entitySet;
      const keyed = def.keys.length > 0;
      const base = { api: api.name, pathPrefix: api.pathPrefix, entitySet: def.entitySet, urlPath, keys: def.keys };
      const ops = def.operations;
      if (isEnabled(ops.list)) tools.push({ ...base, name: `${def.entitySet}_list`, kind: 'list', method: 'GET', scope: requiredScopeOf(ops.list) });
      if (isEnabled(ops.get) && keyed) tools.push({ ...base, name: `${def.entitySet}_get`, kind: 'get', method: 'GET', scope: requiredScopeOf(ops.get) });
      if (!readOnly && isEnabled(ops.create)) tools.push({ ...base, name: `${def.entitySet}_create`, kind: 'create', method: 'POST', scope: requiredScopeOf(ops.create) });
      if (!readOnly && isEnabled(ops.update)) {
        const method = PUT_UPDATE_SETS.includes(def.entitySet) ? 'PUT' : 'PATCH';
        tools.push({ ...base, name: `${def.entitySet}_update`, kind: 'update', method, scope: requiredScopeOf(ops.update) });
      }
      if (!readOnly && isEnabled(ops.delete) && keyed) tools.push({ ...base, name: `${def.entitySet}_delete`, kind: 'delete', method: 'DELETE', scope: requiredScopeOf(ops.delete) });
      for (const nav of def.navigationProperties ?? []) {
        tools.push({ ...base, name: `${def.entitySet}_${nav.name}_list`, kind: 'nav', nav: nav.name, method: 'GET' });
      }
    }
  }
  return tools;
}

/** Every requiredScope string the config declares, on any operation. */
export function declaredRequiredScopes() {
  const scopes = new Set();
  for (const api of apiConfig.apis) {
    for (const def of api.entitySets) {
      for (const op of Object.values(def.operations)) {
        const scope = requiredScopeOf(op);
        if (scope) scopes.add(scope);
      }
    }
  }
  return [...scopes].sort();
}
