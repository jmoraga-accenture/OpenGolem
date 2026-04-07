#!/usr/bin/env tsx
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const [, , fromVersion, toVersion, newCorePath] = process.argv;

if (!fromVersion || !toVersion || !newCorePath) {
  process.stderr.write(
    'Usage: tsx scripts/run-migrations.ts <from-version> <to-version> <new-core-path>\n',
  );
  process.exit(1);
}

const migrationsDir = path.join(newCorePath, 'migrations');

if (!fs.existsSync(migrationsDir)) {
  process.stdout.write(JSON.stringify({ migrationsRun: 0, results: [] }, null, 2) + '\n');
  process.exit(0);
}

function semverCompare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const semverPattern = /^\d+\.\d+\.\d+$/;

const allVersions = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && semverPattern.test(d.name))
  .map((d) => d.name);

const filtered = allVersions
  .filter(
    (v) => semverCompare(v, fromVersion) > 0 && semverCompare(v, toVersion) <= 0,
  )
  .sort(semverCompare);

function resolveTsx(): string {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(local)) return local;
  try {
    const which = execSync('which tsx', { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch {
    // fall through
  }
  return 'npx';
}

const tsxBin = resolveTsx();
const projectRoot = process.cwd();

interface MigrationResult {
  version: string;
  success: boolean;
  error?: string;
}

const results: MigrationResult[] = [];

for (const version of filtered) {
  const migrationScript = path.join(migrationsDir, version, 'index.ts');

  if (!fs.existsSync(migrationScript)) {
    results.push({
      version,
      success: false,
      error: `Migration ${version}/index.ts not found`,
    });
    continue;
  }

  try {
    const args =
      tsxBin === 'npx'
        ? ['tsx', migrationScript, projectRoot]
        : [migrationScript, projectRoot];
    execFileSync(tsxBin, args, {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
    results.push({ version, success: true });
  } catch (err) {
    results.push({
      version,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

process.stdout.write(
  JSON.stringify({ migrationsRun: results.length, results }, null, 2) + '\n',
);

if (results.some((r) => !r.success)) {
  process.exit(1);
}
process.exit(0);
