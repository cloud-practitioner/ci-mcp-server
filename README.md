# CI MCP Server

An MCP (Model Context Protocol) server for SAP Cloud Integration (CPI), powered by [odata-mcp-proxy](https://www.npmjs.com/package/odata-mcp-proxy). It exposes CPI OData APIs as MCP tools, allowing AI assistants like Claude to manage your integration landscape through natural language.

The entire server is defined through a single JSON config file -- no custom code required.

## How It Works

This project uses the `odata-mcp-proxy` npm package, which maps OData/REST services to MCP tools based on a configuration file. You provide a config describing your APIs and entity sets, and the proxy generates the corresponding MCP tools automatically.

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
| `IntegrationPackages` | list, get, create, update, delete | Logical containers that group iFlows, value mappings, and other design-time artifacts |
| `IntegrationDesigntimeArtifacts` | list, get, create, update, delete | iFlow design-time definitions (editable integration logic before deployment) |
| `IntegrationRuntimeArtifacts` | list, get | Deployed integration artifacts (deployment status, version, and errors) |
| `ValueMappingDesigntimeArtifacts` | list, get, create, update, delete | Lookup tables that translate codes/identifiers between sender and receiver systems |
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
| `JmsResources` | list | Individual JMS message queues with depth, capacity, and consumer status |

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

Served from the SAP API Management API portal (`API_DESTINATION`) under `/apiportal/api/1.0/`: `Management.svc` for most tools, `AccessControl.svc` for `ProductAccessRules`, and `Transport.svc` for `APIProxyExports`. Deletes are disabled. The tool descriptions walk an assistant through the create-proxy flow: API provider, API proxy, deploy through `APIProxyDeployments`, then attach it to a product (a proxy must be deployed first).

Reads require the `read` scope and create, update and deploy require `write`. That `requiredScope` enforcement needs the [cloud-practitioner/odata-mcp-proxy](https://github.com/cloud-practitioner/odata-mcp-proxy) fork build; the published odata-mcp-proxy 1.x (including the locked 1.0.0) does not enforce scopes, so any authenticated user can call every registered tool.

The updates of `APIProducts`, `RatePlans`, `CertificateStoreReferences` and `CacheResources` are a full-replacement `PUT`, so the body must carry the whole entity (for a product, every `apiProxies` link to keep). `PUT` updates need the fork build too; the published odata-mcp-proxy 1.x sends `PATCH`, which API Management may reject.

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
| `APIProxyExports` | list | Export one API proxy as a base64-encoded zip bundle (`?name=<proxy>`) |

`APIProxyExports` returns a binary zip. Only the fork build keeps binary responses intact (it returns them base64-encoded); the published odata-mcp-proxy 1.x, including the locked 1.0.0, decodes the zip as text and corrupts it.

Some tools ship disabled because the `read` and `write` scopes are too broad for them, and the published odata-mcp-proxy 1.x does not enforce scopes at all:

- `Applications` `list` and `get`: every application's `app_key` and `app_secret` (gateway API credentials) would be readable with only the `read` scope.
- `Developers` `list` and `get`: developer personal data (name, email, country) would be readable with only the `read` scope.
- `CertificateStores` `create`: the create body carries keystore key pairs and their passwords, which would pass through the assistant. `Certificates` is read-only.

To enable one, set `"enabled": true` on that operation of the entity set in `ci-api-config.json` (for example `"list": { "enabled": true, "requiredScope": "read" }` under `Applications`); the `requiredScope` is already in place.

Some documented API portal services are not exposed because odata-mcp-proxy cannot drive them: importing a proxy zip (`Transport.svc`) or a content archive (`ContentArchive.svc`) needs a `multipart/form-data` upload, and a content archive export needs a `GET` with a request body.

All `_list` tools support OData query parameters: `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`.

## Prerequisites

- **Node.js** 18+ (20+ recommended)
- **SAP BTP account** with a Cloud Foundry environment
- **SAP Cloud Integration** tenant (part of SAP Integration Suite)
- **SAP API Management** (API portal) subscription, only for the API Management tools
- **BTP Destinations** with OAuth2 authentication (see [Configure BTP destination](#2-configure-btp-destination))
- **Cloud Foundry CLI** (`cf`) and **MBT Build Tool** (`mbt`) for deployment

## Project Structure

```
ci-mcp-server/
├── package.json              # Start script + odata-mcp-proxy dependency
├── ci-api-config.json        # API configuration (defines all MCP tools)
├── mta.yaml                  # BTP Cloud Foundry deployment descriptor
├── xs-security.json          # XSUAA OAuth2 configuration
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

This runs `odata-mcp-proxy --config ci-api-config.json`.

### 4. Deploy to BTP

```bash
npm run build:btp     # Build MTA archive
npm run deploy:btp    # Deploy to Cloud Foundry
```

The MTA deployment provisions three service instances:
- **Destination** (lite) -- resolves the CPI API endpoint and manages OAuth2 tokens
- **Connectivity** (lite) -- enables secure backend connectivity
- **XSUAA** (application) -- handles OAuth2 authentication with role-based access control

## Security

The XSUAA configuration (`xs-security.json`) defines three role templates:

| Role | Scopes | Description |
|------|--------|-------------|
| `MCPViewer` | read | Read-only access to CPI and API Management data |
| `MCPEditor` | read, write | Read and modify CPI and API Management data |
| `MCPAdmin` | read, write, admin | Full administrative access |

OAuth2 redirect URIs are pre-configured for Claude.ai, Cursor, Microsoft Teams, and local development.

## License

MIT
