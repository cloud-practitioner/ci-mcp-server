// A local stand-in for the SAP backends. It serves the OAuth token endpoint the
// proxy calls for a destination, the CSRF handshake, and canned OData answers.
// It records every request so a test can assert exactly what the proxy sent.
import { createServer } from 'node:http';

export const FAKE_CLIENT_ID = 'fake-client-id';
export const FAKE_CLIENT_SECRET = 'fake-client-secret';
export const FAKE_ACCESS_TOKEN = 'fake-access-token';
export const FAKE_CSRF_TOKEN = 'fake-csrf-token';

/** Bytes that are not valid UTF-8: a lossy decode would change them. */
export function binaryFixture() {
  const bytes = Buffer.alloc(1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) % 256;
  bytes.set([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28], 0);
  return bytes;
}

export async function startStub() {
  const requests = [];
  const tokenRequests = [];
  const binary = binaryFixture();

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://stub.invalid');

      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        const expected = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`;
        tokenRequests.push({ authorized: req.headers.authorization === expected, body: body.toString('utf8') });
        if (req.headers.authorization !== expected) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: FAKE_ACCESS_TOKEN, token_type: 'bearer', expires_in: 3600 }));
        return;
      }

      const record = {
        method: req.method,
        url: req.url,
        pathname: url.pathname,
        authorization: req.headers.authorization,
        csrf: req.headers['x-csrf-token'],
        contentType: req.headers['content-type'],
        body: body.toString('utf8'),
      };

      // CSRF handshake: the SDK asks for a token before a mutating request.
      if (String(record.csrf).toLowerCase() === 'fetch') {
        record.handshake = true;
        requests.push(record);
        res.writeHead(200, { 'x-csrf-token': FAKE_CSRF_TOKEN });
        res.end();
        return;
      }
      requests.push(record);

      if (record.authorization !== `Bearer ${FAKE_ACCESS_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: { value: 'stub: bad authorization' } } }));
        return;
      }
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && record.csrf !== FAKE_CSRF_TOKEN) {
        res.writeHead(403, { 'x-csrf-token': 'Required', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: { value: 'stub: CSRF token validation failed' } } }));
        return;
      }

      if (req.method === 'GET' && url.pathname.endsWith('/$value')) {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(binary);
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ d: { results: [] } }));
        return;
      }
      if (req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ d: { created: true } }));
        return;
      }
      res.writeHead(204).end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    binary,
    /** Requests that carry a tool call, without the CSRF handshakes. */
    get calls() {
      return requests.filter((r) => !r.handshake);
    },
    get handshakes() {
      return requests.filter((r) => r.handshake);
    },
    tokenRequests,
    reset() {
      requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Environment that points both configured destinations at the stub. */
export function destinationEnv(baseUrl) {
  const env = {};
  for (const prefix of ['CPI_DESTINATION', 'API_DESTINATION']) {
    env[`${prefix}_BASE_URL`] = baseUrl;
    env[`${prefix}_TOKEN_URL`] = `${baseUrl}/oauth/token`;
    env[`${prefix}_CLIENT_ID`] = FAKE_CLIENT_ID;
    env[`${prefix}_CLIENT_SECRET`] = FAKE_CLIENT_SECRET;
  }
  return env;
}
