/** Best-effort node-pty version for diagnostics; null when unavailable. */
export async function nodePtyVersion(): Promise<string | null> {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkg = req('node-pty/package.json') as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}


/** A false capability on one backend must never mask a true fallback capability. */
export function anyBackendCapability(...values: Array<boolean | null | undefined>): boolean {
  return values.some((value) => value === true);
}
