/**
 * OpenGolem Native Credential Proxy
 *
 * A local HTTP reverse proxy that runs on the host and injects API credentials
 * into outbound Anthropic API calls from containers. Containers are configured
 * with ANTHROPIC_BASE_URL pointing to this proxy; the proxy adds the auth
 * header and forwards to the real upstream.
 *
 * This is the M1 placeholder for the Token Broker (Milestone 2). In M2 this
 * will be replaced by the full Token Broker with scoped, time-limited tokens.
 *
 * Auth modes (checked in order):
 *   1. CLAUDE_CODE_OAUTH_TOKEN  → Authorization: Bearer <token>  (Enterprise/Pro)
 *   2. ANTHROPIC_AUTH_TOKEN     → Authorization: Bearer <token>  (alias)
 *   3. ANTHROPIC_API_KEY        → x-api-key: <key>               (API key)
 *
 * Upstream: ANTHROPIC_BASE_URL_UPSTREAM (default: https://api.anthropic.com)
 */
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import url from 'url';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface ProxyConfig {
  port: number;
  host: string;
  upstreamUrl: string;
  authHeader: { name: string; value: string } | null;
}

function resolveAuthHeader(): { name: string; value: string } | null {
  const env = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);

  const oauthToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) {
    return { name: 'Authorization', value: `Bearer ${oauthToken}` };
  }

  const authToken =
    process.env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
  if (authToken) {
    return { name: 'Authorization', value: `Bearer ${authToken}` };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return { name: 'x-api-key', value: apiKey };
  }

  return null;
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

  const authHeader = resolveAuthHeader();
  if (!authHeader) {
    logger.warn(
      'Credential proxy: no credentials found in .env ' +
        '(ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN). ' +
        'Containers will receive 401 errors from Anthropic.',
    );
  } else {
    logger.info(
      { port, host, authMode: authHeader.name },
      'Credential proxy started',
    );
  }

  const upstreamParsed = new url.URL(upstreamBase);
  const isHttps = upstreamParsed.protocol === 'https:';
  const upstreamHost = upstreamParsed.hostname;
  const upstreamPort = upstreamParsed.port
    ? parseInt(upstreamParsed.port, 10)
    : isHttps
      ? 443
      : 80;

  server = http.createServer((req, res) => {
    // Re-resolve auth on every request so .env changes take effect without restart
    const currentAuth = resolveAuthHeader();

    const outHeaders: Record<string, string | string[]> = {};

    // Forward original headers, stripping hop-by-hop and injecting auth
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
        lower === 'authorization'
      ) {
        continue;
      }
      if (val !== undefined) outHeaders[key] = val as string | string[];
    }

    outHeaders['host'] = upstreamHost;

    if (currentAuth) {
      outHeaders[currentAuth.name] = currentAuth.value;
    }

    const options: https.RequestOptions = {
      hostname: upstreamHost,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: outHeaders,
      timeout: 30000,
    };

    const transport = isHttps ? https : http;
    const proxyReq = transport.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('timeout', () => {
      logger.error('Credential proxy upstream request timed out after 30s');
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

    req.pipe(proxyReq, { end: true });
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
