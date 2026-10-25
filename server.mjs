import { fileURLToPath } from 'node:url';

process.env.API_CONFIG_FILE = fileURLToPath(new URL('./ci-api-config.json', import.meta.url));

try {
  // Importing the proxy loads default-env.json and .env, but does not start it.
  const { start } = await import('odata-mcp-proxy');
  const readOnly = process.env.MCP_READ_ONLY;
  // The pinned parser trims input, which would silently turn whitespace into off.
  // Leave all other validation to the proxy's parser.
  if (readOnly !== undefined && readOnly !== readOnly.trim()) {
    throw new Error('MCP_READ_ONLY accepts only true, false, 1, 0 (case-insensitive), unset or empty; whitespace is not allowed.');
  }
  await start();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
