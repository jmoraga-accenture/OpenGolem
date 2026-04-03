#!/usr/bin/env tsx
/**
 * npm run status — query the /health endpoint and display a summary.
 *
 * Usage:
 *   npm run status               # default port 3003
 *   HEALTH_PORT=3003 npm run status
 */
import http from 'http';

const port = parseInt(process.env.HEALTH_PORT || '3003', 10);
const url = `http://127.0.0.1:${port}/health`;

function fmt(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

http.get(url, (res) => {
  let body = '';
  res.on('data', (chunk: Buffer) => (body += chunk.toString()));
  res.on('end', () => {
    if (res.statusCode !== 200) {
      process.stderr.write(`Error: /health returned HTTP ${res.statusCode}\n`);
      process.exit(1);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      process.stderr.write(`Error: /health response is not valid JSON\n`);
      process.exit(1);
    }

    process.stdout.write(`\nOpenGolem status  (${url})\n`);
    process.stdout.write('─'.repeat(50) + '\n');
    fmt('Status', String(data.status ?? 'unknown'));
    fmt('Uptime', `${data.uptime_seconds ?? 0}s`);
    fmt('Active containers', String(data.active_containers ?? 0));
    fmt('Broker socket', String(data.broker_socket ?? 'unknown'));
    fmt('Cato socket', String(data.cato_socket ?? 'unknown'));

    const dao = data.dao_score as Record<string, number> | null | undefined;
    if (dao) {
      fmt(
        'dao_score security_failures',
        dao.security_failures_per_call.toFixed(4),
      );
      fmt('dao_score data_leaks', dao.data_leaks_per_call.toFixed(4));
      fmt('dao_score behavioral_change', dao.behavioral_change_rate.toFixed(4));
    } else {
      fmt('dao_score', 'no snapshot yet');
    }

    const blocks = data.recent_blocks as Array<Record<string, unknown>> | undefined;
    if (blocks && blocks.length > 0) {
      process.stdout.write('\nRecent blocks:\n');
      for (const b of blocks) {
        process.stdout.write(
          `  [${b.ts}] ${b.container}  ${b.outcome}  rule=${b.block_rule ?? 'n/a'}\n`,
        );
      }
    } else {
      process.stdout.write('\nRecent blocks: none\n');
    }
    process.stdout.write('\n');
  });
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNREFUSED') {
    process.stderr.write(
      `Cannot connect to health endpoint at ${url}\n` +
        'Is OpenGolem running? Check HEALTH_PORT (default 3003).\n',
    );
  } else {
    process.stderr.write(`Error: ${err.message}\n`);
  }
  process.exit(1);
});
