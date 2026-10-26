# CI MCP Server

An MCP (Model Context Protocol) server for SAP Cloud Integration (CPI), powered by [odata-mcp-proxy](https://github.com/cloud-practitioner/odata-mcp-proxy). It exposes CPI OData APIs as MCP tools, allowing AI assistants like Claude to manage your integration landscape through natural language.

The API tools are defined through a single JSON config file -- no custom tool handlers required.

## How It Works

This project uses the `odata-mcp-proxy` package, pinned to the [cloud-practitioner/odata-mcp-proxy](https://github.com/cloud-practitioner/odata-mcp-proxy) fork via the `git+https` dependency in [package.json](package.json), which maps OData/REST services to MCP tools based on a configuration file. You provide a config describing your APIs and entity sets, and the proxy generates the corresponding MCP tools automatically.

```
AI Assistant (Claude, Cursor, etc.)
        |
        | MCP Protocol (HTTP or stdio)
        v
  odata-mcp-proxy
        |
        | REST + OAuth2 (via BTP Destination Service)
        v
  SAP Cloud Integration OData API
```

Think of it like the [SAP Application Router](https://www.npmjs.com/package/@sap/approuter) -- a ready-made runtime you configure, not code you write.

## Exposed APIs

The config file (`ci-api-config.json`) exposes the SAP Cloud Integration OData API and the SAP API Management API, organized into the following categories:

### Integration Content

| Tool | Operations | Description |
|------|-----------|-------------|
| `IntegrationPackages` | list, get, create, update, delete | Logical containers that group iFlows, value mappings, and other design-time artifacts. Navigation tools such as `IntegrationPackages_IntegrationDesigntimeArtifacts_list` list the design-time artifacts of one package |
| `IntegrationDesigntimeArtifacts` | list, get, create, update, delete | iFlow design-time definitions (editable integration logic before deployment) |
| `IntegrationRuntimeArtifacts` | list, get, delete | Deployed integration artifacts (deployment status, version, and errors) |
| `ValueMappingDesigntimeArtifacts` | list, get, create, delete | Lookup tables that translate codes/identifiers between sender and receiver systems |
| `MessageMappingDesigntimeArtifacts` | list, get, create, update, delete | Graphical structure-to-structure transformations between message formats |
| `ScriptCollectionDesigntimeArtifacts` | list, get, create, update, delete | Reusable Groovy or JavaScript libraries shared across iFlows |
| `CustomTagConfigurations` | list, get, create, update, delete | Tenant-level labels for categorizing and filtering integration packages |
| `BuildAndDeployStatus` | list, get | Track whether an iFlow deployment is queued, running, or finished |

### Message Processing Logs

| Tool | Operations | Description |
|------|-----------|-------------|
| `MessageProcessingLogs` | list, get | Execution history for iFlows, used to debug failed messages or monitor processing |
| `IdMapFromId2s` | list | ID mapping entries for exactly-once processing (source-to-target ID mappings) |
| `IdempotentRepositoryEntries` | list | Duplicate-check records ensuring a message is processed only once |

### Message Stores

| Tool | Operations | Description |
|------|-----------|-------------|
| `DataStoreEntries` | list, get, delete | Key-value records persisted by iFlows for cross-message data sharing |
| `Variables` | list, get | Runtime variables persisted between iFlow executions (timestamps, counters, delta tokens) |
| `NumberRanges` | list, get | Auto-incrementing counters for generating unique sequence numbers |
| `MessageStoreEntries` | list, get | Full messages persisted via the Persist step for later retrieval or retry |
| `JmsBrokers` | list, get | Messaging broker instances provisioned on the tenant |
| `JmsResources` | list | Individual JMS message queues with message count, size, fill grade, and state (the `Queues` entity set) |

### Log Files

| Tool | Operations | Description |
|------|-----------|-------------|
| `LogFiles` | list, get | Tenant-level runtime logs (HTTP, default trace, audit) for troubleshooting |
| `LogFileArchives` | list, get | Compressed historical log bundles available for download |

### Security Content

| Tool | Operations | Description |
|------|-----------|-------------|
| `KeystoreEntries` | list, get, delete | SSL/TLS certificates, key pairs, and trusted CA certificates |
| `CertificateResources` | list, get | Full X.509 certificate chains for verifying trust paths |
| `SSHKeyResources` | list, get | Public/private key pairs for SFTP adapter connectivity |
| `UserCredentials` | list, get, create, update, delete | Stored username/password pairs for basic-auth connections |
| `OAuth2ClientCredentials` | list, get, create, update, delete | Client ID/secret pairs and token endpoints for OAuth2 connections |
| `SecureParameters` | list, get, create, update, delete | Encrypted key-value entries for sensitive configuration values |
| `CertificateUserMappings` | list, get, create, update, delete | Rules mapping inbound client certificates to CPI user roles |
| `AccessPolicies` | list, get, create, update, delete | Fine-grained authorization rules for integration artifacts |

### Partner Directory

| Tool | Operations | Description |
|------|-----------|-------------|
| `Partners` | list, get, create, update, delete | Trading partner entries driving dynamic iFlow routing |
| `StringParameters` | list, get, create, update, delete | Partner-specific text configuration values (endpoints, format codes) |
| `BinaryParameters` | list, get, create, update, delete | Partner-specific file-based configuration (XSLT, certificates, mappings) |
| `AlternativePartners` | list, get, create, update, delete | Additional partner identifiers (DUNS, GLN) mapping to a primary partner |
| `AuthorizedUsers` | list, get, create, update, delete | Users permitted to send messages on behalf of a specific partner |

### API Management

Served from the SAP API Management API portal (`API_DESTINATION`) under `/apiportal/api/1.0/`: `Management.svc` for most tools and `AccessControl.svc` for `ProductAccessRules`. Deletes are disabled. The tool descriptions walk an assistant through the create-proxy flow: API provider, API proxy, deploy through `APIProxyDeployments`, then attach it to a product (a proxy must be deployed first).

API Management reads require the `read` scope and create, update and deploy require `write`. See [Security](#security) for when the pinned fork enforces caller scopes.

The updates of `APIProducts`, `RatePlans`, `CertificateStoreReferences` and `CacheResources` are a full-replacement `PUT`, so the body must carry the whole entity (for a product, every `apiProxies` link to keep). This relies on the per-operation update methods provided by the pinned cloud-practitioner/odata-mcp-proxy fork; the previously published 1.0.0 sends `PATCH`, which API Management may reject.

| Tool | Operations | Description |
|------|-----------|-------------|
| `APIProviders` | list, get, create, update | Named backend connections that API proxies target |
| `APIProxies` | list, get, create, update | API proxies with their proxy endpoints, target endpoints, and policies |
| `APIProxyDeployments` | list, get, create, update | Proxy deployment records; deploying a proxy is a create here |
| `APIProducts` | list, get, create, update | Bundles of deployed API proxies published to developers |
| `APIProxyEndPoints` | list, get, create, update | Client-facing side of a proxy (base path, virtual hosts, route rules) |
| `APITargetEndPoints` | list, get, create, update | Backend side of a proxy (URL or API provider) |
| `VirtualHosts` | list, get, create, update | Hostnames and ports on which proxy endpoints are exposed |
| `KeyMapEntries`, `KeyMapEntryValues` | list, get, create, update | Environment key value maps and their entries |
| `GenericKeyMapEntries`, `GenericKeyMapEntryValues` | list, get, create, update | Scoped key value maps and their entries |
| `APIResources` | list, get, create, update | Documented operations (resource paths and enabled methods) of a proxy endpoint |
| `Documentations` | list, get, create, update | Per-locale documentation of an API resource |
| `Policies` | list, get, create, update | Policy definitions (policy XML) attached to an API proxy |
| `GetAllRevisions` | list | Saved revisions of one API proxy (`?apiProxyName='<name>'`) |
| `APIProductAdditionalProperties` | list, get, create, update | Custom attributes of an API product, readable by policies at runtime |
| `RatePlans` | list, get, create, update (PUT) | Monetization rate plans attached to products |
| `Applications` | list, get (disabled by default) | Developer applications subscribed to products (the response includes the app key and secret) |
| `Developers` | list, get (disabled by default) | Application developers registered for the API portal |
| `CertificateStores` | list, get, create (create disabled by default) | Keystores and truststores |
| `Certificates` | list, get | Certificates inside a keystore or truststore, with expiry details |
| `CertificateStoreReferences` | list, get, create, update (PUT) | Named aliases that point at a keystore or truststore |
| `CacheResources` | list, get, create, update (PUT) | Named caches used by the caching policies |
| `ProductAccessRules` | list, get, create | Role-based Discovery and Subscription permissions for restricted products (`AccessControl.svc/Rules`) |

Some operations ship disabled as hardening by default:

- `Applications` `list` and `get`: they return every application's `app_key` and `app_secret` (gateway API credentials).
- `Developers` `list` and `get`: they return developer personal data (name, email, country).
- `CertificateStores` `create`: the create body carries keystore key pairs and their passwords. `Certificates` is read-only.

To enable one, replace its `false` in `ci-api-config.json` with `{ "enabled": true, "requiredScope": "admin" }`, for example `"list": { "enabled": true, "requiredScope": "admin" }` under `Applications`. Scope enforcement follows the policy described in [Security](#security).

Disabling these operations and requiring `admin` to re-enable them is defense in depth, not an access-control boundary. The pinned cloud-practitioner/odata-mcp-proxy fork rejects `..` and percent-encoded dot segments (such as `%2e%2e`) through its shared path guard before backend execution. For example, `APIProxies_list` with `path: "/../Applications"` now returns an error instead of reaching `Applications`; this traversal route to `Applications`, `Developers` or `CertificateStores` is blocked. This traversal guard is not a substitute for comprehensive entity-level authorization; restrict the `API_DESTINATION` technical user's backend permissions accordingly.

Some documented API portal services remain unconfigured:

- Exporting an API proxy (`Transport.svc/APIProxies?name=<proxy>`) returns a binary zip. The pinned fork supports binary-safe responses, but this config does not expose an export tool.
- Importing a proxy zip (`Transport.svc`) or a content archive (`ContentArchive.svc`) needs a `multipart/form-data` upload.
- Exporting a content archive needs a `GET` with a request body.

The pinned fork honours both plain `false` and the object form `{ "enabled": false }` in `ci-api-config.json`: either omits the corresponding CRUD tool. The CI entries using the object form do not need migration to plain `false`.

### Query options

Every `_list` tool takes an OData `path` suffix, for example `?$top=10`. The server forwards it unchanged. SAP Cloud Integration does not support every query option on every entity set, and a set that does not support an option answers with HTTP 501, 400 or 500. Check a set in the SAP Business Accelerator Hub before you rely on an option.

A tool call with an argument that the tool does not declare, for example `unknownArg`, fails with a tool error before any request to the tenant. Use only the arguments in the tool's input schema: `path`, `body` and `headers`.

Observed with `GET` requests on one Cloud Foundry tenant. A Neo tenant may answer differently.

| Entity set | Result |
|------------|--------|
| API Management sets, for example `APIProxies` | `$filter`, `$select`, `$orderby`, `$skip`, `$top` and `$inlinecount` work. `$expand` needs a navigation property that the set declares. |
| `IntegrationRuntimeArtifacts`, `MessageProcessingLogs` | `$filter`, `$select`, `$orderby`, `$skip` and `$top` work. On `MessageProcessingLogs`, `$expand=Runs` returns 501. |
| `IntegrationPackages` | `$top`, `$skip` and `$orderby` work. `$select`, `$filter`, `$inlinecount` and `$expand` return 501. |
| `NumberRanges` | No query option works. Every option, including `$top`, returns 501. |
| `LogFiles`, `LogFileArchives` | `$top` returns 501. List them without a path. On `LogFiles`, `$select` works and `$orderby` and `$skip` return 501. |

### Sets that cannot be listed

On the same tenant a plain list of these sets returns HTTP 501. The tool description of each set says how to read it:

| Entity set | How to read it |
|------------|----------------|
| `IntegrationDesigntimeArtifacts` | `IntegrationPackages_IntegrationDesigntimeArtifacts_list` with path `('<PackageId>')`, or `IntegrationDesigntimeArtifacts_get` with `(Id='<Id>',Version='<Version>')` |
| `ScriptCollectionDesigntimeArtifacts` | `IntegrationPackages_ScriptCollectionDesigntimeArtifacts_list` with path `('<PackageId>')`, or the get tool |
| `CustomTagConfigurations` | `CustomTagConfigurations_get` with path `('CustomTags')/$value`. An entity read of the same key also returns 501. |
| `BuildAndDeployStatus` | `BuildAndDeployStatus_get` with `('<TaskId>')`, where the TaskId comes from a deploy request |
| `MessageStoreEntries` | `MessageProcessingLogs_MessageStoreEntries_list` with `('<MessageGuid>')`, or `MessageStoreEntries_get` with `('<Id>')` |
| `JmsBrokers` | `JmsBrokers_get` with `('Broker1')`. Add `?$expand=QueueStates` or `?$expand=InactiveQueues` for queue states. |

The other design-time artifact sets of a package are listed the same way, with `IntegrationPackages_<Set>_list` and the path `('<PackageId>')`.

`JmsResources_list` reads the `Queues` entity set. The name `JmsResources` is the SAP documentation topic, not an entity set. `GetAllRevisions_list` needs the proxy name: pass `?apiProxyName='<name>'`.

## Prerequisites

- **Node.js** 22.x (declared in `engines.node` in [package.json](package.json)), matching the default Node.js version of the Cloud Foundry Node.js buildpack.
- **Git** and outbound access to GitHub for dependency installation, including the MTA npm builder
- **SAP BTP account** with a Cloud Foundry environment
- **SAP Cloud Integration** tenant (part of SAP Integration Suite)
- **SAP API Management** (API portal) subscription, only for the API Management tools
- **BTP Destinations** with OAuth2 authentication (see [Configure BTP destination](#2-configure-btp-destination))
- **Cloud Foundry CLI** (`cf`) and **MBT Build Tool** (`mbt`) for deployment

## Project Structure

```
ci-mcp-server/
├── package.json              # Start script + odata-mcp-proxy dependency
├── server.mjs                # App entry point with strict read-only startup validation
├── ci-api-config.json        # API configuration (defines all MCP tools)
├── mta.yaml                  # BTP Cloud Foundry deployment descriptor
├── xs-security.json          # XSUAA OAuth2 configuration
├── test/                     # `npm test` (offline) and `npm run test:live` (opt-in, GET only)
├── default-env.json          # Local dev credentials (gitignored)
└── LICENSE
```

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure BTP destination

Create the BTP Destinations the config refers to:

| Destination | URL |
|-------------|-----|
| `CPI_DESTINATION` | `https://<tenant>.it-cpi0<xx>.cfapps.<region>.hana.ondemand.com` |
| `API_DESTINATION` | API Management API portal URL (from the API portal service key), used by the analytics and API Management tools |

The destination should use OAuth2 client credentials authentication with the CPI service key credentials.

### 3. Local development

Create a `default-env.json` with your BTP service bindings (XSUAA, Destination, Connectivity) to run locally:

```bash
npm start
```

This runs `server.mjs`, which starts the pinned proxy with `ci-api-config.json`. See [Security](#security) for the read-only startup rules.

### 4. Deploy to BTP

```bash
npm run build:btp     # Build MTA archive
npm run deploy:btp    # Deploy to Cloud Foundry
```

The MTA deployment provisions three service instances:
- **Destination** (lite) -- resolves the CPI API endpoint and manages OAuth2 tokens
- **Connectivity** (lite) -- enables secure backend connectivity
- **XSUAA** (application) -- handles OAuth2 authentication with role-based access control

## Testing

### Offline contract test: `npm test`

`npm test` needs no network and no credentials. It runs on Node.js 22 and 24 with the built-in `node:test` runner and adds no dependency.

The test starts the pinned `odata-mcp-proxy` over stdio with the real `ci-api-config.json`, a local stub backend and fake credentials. It checks that:

- the tool names equal the set derived from `ci-api-config.json`, and `MCP_READ_ONLY=true` registers only read tools
- every tool sends the expected HTTP method and URL: `PUT` for the updates of `APIProducts`, `RatePlans`, `CertificateStoreReferences` and `CacheResources`, `PATCH` for the other updates, and `AccessControl.svc/Rules` for `ProductAccessRules`
- a binary `$value` download round-trips byte for byte
- stdout carries only JSON-RPC
- every `requiredScope` in `ci-api-config.json` is declared in `xs-security.json`, and no role collection claims more than its scopes allow
- over HTTP, `/health` answers, the server refuses to start on Cloud Foundry without XSUAA, `/mcp` answers 401 with an XSUAA binding, and the working-directory `xs-security.json` sets the OAuth redirect allowlist

When you add or remove a tool in `ci-api-config.json`, update the two tool counts at the top of `test/contract.test.mjs`.

### Live smoke test: `npm run test:live`

`npm run test:live` is opt-in and is not part of `npm test`. It reads from a real tenant and sends only `GET` requests. Run it before you re-pin `odata-mcp-proxy`.

How it stays read-only:

- It starts the proxy with `MCP_READ_ONLY=true`.
- It puts a local forwarder between the proxy and the tenant. The forwarder passes `GET` and answers every other method with 405.
- The only `POST` it sends is the OAuth token request to the token URL.

For listable sets, it requests `?$top=1` first. Only `NumberRanges`, `LogFiles` and `LogFileArchives` also receive a plain unrestricted list, to check their documented `$top` limitation. The [key-addressed sets](#sets-that-cannot-be-listed) receive only the plain-list probe that can return 501. There is no unrestricted fallback for other sets, including `MessageProcessingLogs`, `Policies` and `ResultsUTC`. It skips sensitive sets that hold credentials, keys, key-value data, partner parameters or message data; `SENSITIVE_SETS` in [test/live-smoke.mjs](test/live-smoke.mjs) defines the exclusions.

It calls `GetAllRevisions` with an `apiProxyName` taken from the bounded API proxy list and checks that omitting the parameter returns 400. It searches at most the first 20 packages for an iFlow, checks all configured package-navigation tools, and downloads one iFlow through `IntegrationDesigntimeArtifacts_get` with `/$value`. Failed or malformed discovery is a failure, not an empty-data skip; successful discovery with no packages or iFlows may skip the dependent checks. The forwarder streams responses while hashing and counting their bytes, retaining no response bodies. The download check keeps only the MCP-decoded and direct-GET bytes needed for comparison.

Set these environment variables. Destination URLs and credentials are never printed; the result file path is printed:

| Variable | Value |
|----------|-------|
| `CPI_DESTINATION_BASE_URL`, `CPI_DESTINATION_TOKEN_URL`, `CPI_DESTINATION_CLIENT_ID`, `CPI_DESTINATION_CLIENT_SECRET` | OAuth2 client credentials of the Cloud Integration API |
| `API_DESTINATION_BASE_URL`, `API_DESTINATION_TOKEN_URL`, `API_DESTINATION_CLIENT_ID`, `API_DESTINATION_CLIENT_SECRET` | OAuth2 client credentials of the API Management API portal |
| `LIVE_RESULTS_FILE` (optional) | Path of the JSON result. The default is `test-results/live-<timestamp>.json`, which git ignores. |

```bash
# Load your credentials into this shell without printing them, then run the test.
set -a; . /path/to/your/credentials.env; set +a
npm run test:live
```

A completed run prints PASS and exits with 0 when no unexpected failure occurred; otherwise it prints FAIL and exits with 1. Missing required environment variables stop the command before the run with exit code 2 and a list of missing variable names, without creating a report. Required list, navigation, keyed-read, discovery and download failures count as failures. The JSON result holds tool names, fixed diagnostic codes, HTTP statuses, item counts and sizes. Raw proxy, authentication and tenant error text is never published in the report or console output. It holds no tenant host, no id, no token and no business data. Use it as evidence in a pull request.

Some tool calls fail on purpose on a Cloud Foundry tenant. See [Query options](#query-options). Only the documented operation-specific responses are exempt: 501 for a plain list of a key-addressed set, 501 for `$top` on the three unsupported sets (whose plain list must still succeed), and 400 for `GetAllRevisions` without its required parameter. A key-addressed plain-list 501 is labeled "fails (known limit)"; membership in a known-limit set never exempts an unexpected status.

`npm test` also runs the live CLI against a local tenant stub to cover its evidence privacy, bounded requests, download comparison and PASS/FAIL classification without credentials or external requests.

## Security

The pinned cloud-practitioner/odata-mcp-proxy fork enforces `requiredScope` against the caller's JWT over HTTP when XSUAA is bound. Over stdio, or HTTP without XSUAA, it skips caller-scope checks and backend access is governed by the destination credentials instead. Do not expose unauthenticated HTTP as a role-protected server.

The XSUAA configuration (`xs-security.json`) defines three role templates:

| Role | Scopes | Description |
|------|--------|-------------|
| `MCPViewer` | read | Read-only access to CPI and API Management data |
| `MCPEditor` | read, write | Read and modify CPI and API Management data |
| `MCPAdmin` | read, write, admin | Full administrative access |

OAuth2 redirect URIs are configured in the app-root [xs-security.json](xs-security.json) for Claude.ai, Cursor, Microsoft Teams, and local development. With `npm start`, the proxy loads that file from the app's working directory. `XS_SECURITY_JSON_PATH`, if set, takes precedence (relative paths resolve from the working directory); an invalid explicit file fails startup. If no working-directory file exists, the proxy falls back to its bundled configuration.

With XSUAA bound over HTTP, OAuth uses the shared `@arc-mcp/xsuaa-auth` provider. Dynamic client registration accepts only public clients (`token_endpoint_auth_method: "none"`) and `client_secret_post` clients (the default); `client_secret_basic` and other methods are rejected. Registered redirect URIs must match the configured allowlist.

Before it sends the browser to XSUAA, the proxy shows an **Approve and continue** or **Deny** page that names the client and its return address. Approval is required for every new authorization flow, even when an SSO session already exists. A transport reconnect with a valid token or a token refresh does not show the page again. See [GHSA-6935-r3wv-f646](https://github.com/arc-mcp/arc-1/security/advisories/GHSA-6935-r3wv-f646).

Each dynamic registration gets a random suffix on its `client_name` (for example `My Client #Xk3...`), so two registrations with the same metadata receive different client IDs and secrets. The displayed client name remains client-supplied and unverified; it is not proof of the client's identity.

`MCP_READ_ONLY` accepts only `true`, `false`, `1` and `0`, in any case. `true` or `1` enables read-only mode; `false`, `0`, unset or empty means off. Any other value, including whitespace-only or whitespace-padded values, stops the server at startup. The entry point validates the value after loading `default-env.json` and `.env`.

The proxy disables the MCP SDK's per-IP rate limits on authorization, token, registration, and revocation endpoints. Apply rate limiting at the ingress when exposing these endpoints.

## License

MIT
