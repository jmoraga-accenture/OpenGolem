/**
 * OpenGolem Credential Proxy
 *
 * A local HTTP reverse proxy that injects API credentials into outbound
 * Anthropic API calls from containers. Containers point ANTHROPIC_BASE_URL
 * here; the proxy resolves credentials via the Token Broker's credential
 * backend and forwards to the real upstream.
 *
 * Credentials are resolved on every request so rotations take effect
 * immediately without a restart.
 *
 * Upstream: ANTHROPIC_BASE_URL_UPSTREAM (default: https://api.anthropic.com)
 */
import http from 'http';
import https from 'https';
import os from 'os';
import url from 'url';

import { createCredentialBackend } from './broker/credentials/factory.js';
import { inspectRequest } from './inspector/index.js';
import { logger } from './logger.js';

const credentialBackend = createCredentialBackend();

async function resolveAuthHeader(): Promise<{
  name: string;
  value: string;
} | null> {
  try {
    const cred = await credentialBackend.resolve();
    return { name: cred.headerName, value: cred.headerValue };
  } catch (err) {
    logger.warn(
      { err },
      'Credential backend failed to resolve — requests will be unauthenticated',
    );
    return null;
  }
}

function resolveBindHost(): string {
  // On Linux, bind to the docker0 bridge so containers can reach us.
  // Docker bridge IP is typically 172.17.0.1 but can vary — find it dynamically.
  if (os.platform() === 'linux') {
    const ifaces = os.networkInterfaces();
    const docker0 = ifaces['docker0'];
    if (docker0) {
      const ipv4 = docker0.find((i) => i.family === 'IPv4');
      if (ipv4) return ipv4.address;
    }
    // Rootless Docker or custom network — bind to all interfaces as fallback
    return process.env.CREDENTIAL_PROXY_HOST || '0.0.0.0';
  }
  // macOS/Windows: host.docker.internal resolves back to host; bind to loopback
  return process.env.CREDENTIAL_PROXY_HOST || '127.0.0.1';
}

let server: http.Server | null = null;

export function startCredentialProxy(): { port: number; host: string } {
  const port = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
  const host = resolveBindHost();
  const upstreamBase =
    process.env.ANTHROPIC_BASE_URL_UPSTREAM || 'https://api.anthropic.com';

  logger.info(
    { port, host, backend: credentialBackend.name },
    'Credential proxy started',
  );

  const upstreamParsed = new url.URL(upstreamBase);
  const isHttps = upstreamParsed.protocol === 'https:';
  const upstreamHost = upstreamParsed.hostname;
  const upstreamPort = upstreamParsed.port
    ? parseInt(upstreamParsed.port, 10)
    : isHttps
      ? 443
      : 80;

  server = http.createServer((req, res) => {
    // Buffer request body for Call Inspector scanning (M3).
    // Streaming *responses* from Anthropic are not buffered — they pipe through.
    const bodyChunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));

    req.on('error', (err) => {
      logger.error({ err }, 'Credential proxy: request body read error');
      if (!res.headersSent) res.writeHead(502);
      res.end('Proxy error');
    });

    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);

      // Re-resolve auth on every request so credential rotations take effect immediately
      resolveAuthHeader()
        .then((currentAuth) => {
          // --- Call Inspector (M3) ---
          const inspection = inspectRequest(
            req.url ?? '/',
            body.toString('utf8'),
          );
          if (!inspection.allow) {
            logger.warn(
              { rule: inspection.blockRule, url: req.url },
              'Credential proxy: request blocked by Call Inspector',
            );
            if (!res.headersSent) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
            }
            res.end(
              JSON.stringify({ error: 'blocked', rule: inspection.blockRule }),
            );
            return;
          }

          const outHeaders: Record<string, string | string[]> = {};

          // Forward original headers, stripping hop-by-hop, auth (replaced below),
          // and content-length (recalculated from buffered body).
          for (const [key, val] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            if (
              lower === 'connection' ||
              lower === 'keep-alive' ||
              lower === 'proxy-authenticate' ||
              lower === 'proxy-authorization' ||
              lower === 'te' ||
              lower === 'trailers' ||
              lower === 'transfer-encoding' ||
              lower === 'upgrade' ||
              lower === 'host' ||
              lower === 'x-api-key' ||
              lower === 'authorization' ||
              lower === 'content-length'
            ) {
              continue;
            }
            if (val !== undefined) outHeaders[key] = val as string | string[];
          }

          outHeaders['host'] = upstreamHost;
          if (body.length > 0)
            outHeaders['content-length'] = String(body.length);

          if (currentAuth) {
            outHeaders[currentAuth.name] = currentAuth.value;
          }

          const options: https.RequestOptions = {
            hostname: upstreamHost,
            port: upstreamPort,
            path: req.url,
            method: req.method,
            headers: outHeaders,
            timeout: 90000,
          };

          const transport = isHttps ? https : http;
          const proxyReq = transport.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
          });

          proxyReq.on('timeout', () => {
            logger.error(
              'Credential proxy upstream request timed out after 90s',
            );
            proxyReq.destroy();
            if (!res.headersSent) res.writeHead(504);
            res.end('Upstream timeout');
          });

          proxyReq.on('error', (err) => {
            logger.error({ err }, 'Credential proxy upstream error');
            if (!res.headersSent) {
              res.writeHead(502);
            }
            res.end('Credential proxy upstream error');
          });

          if (body.length > 0) proxyReq.write(body);
          proxyReq.end();
        })
        .catch((err) => {
          logger.error(
            { err },
            'Credential proxy: failed to resolve auth header',
          );
          if (!res.headersSent) res.writeHead(502);
          res.end('Credential proxy error');
        });
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        { port },
        'Credential proxy port already in use. Set CREDENTIAL_PROXY_PORT to a different port.',
      );
    } else {
      logger.error({ err }, 'Credential proxy server error');
    }
  });

  server.listen(port, host);
  return { port, host };
}

export function stopCredentialProxy(): void {
  if (server) {
    server.close();
    server = null;
  }
}

/**
 * Returns the ANTHROPIC_BASE_URL value containers should use to reach
 * this proxy via host.docker.internal.
 */
export function getContainerProxyUrl(port: number): string {
  return `http://host.docker.internal:${port}`;
}

// Re-export for callers that previously imported detectAuthMode from here
export { detectAuthMode, type AuthMode } from './broker/credentials/factory.js';
