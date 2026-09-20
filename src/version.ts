import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let cached: string | undefined;

/** Single source of truth for the package version (read from package.json). */
export function packageVersion(): string {
  if (cached) return cached;
  // Works from src (tsx) and from dist/src (built package): walk upward until
  // a package.json with a matching name is found.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkgPath = path.join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string; name?: string };
      if (pkg.version && (pkg.name === 'freebuff-mcp' || i > 0)) {
        cached = pkg.version;
        return cached;
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('freebuff-mcp/package.json') as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export const VERSION = packageVersion();
