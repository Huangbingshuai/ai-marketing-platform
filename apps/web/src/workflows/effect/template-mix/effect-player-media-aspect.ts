/** Media geometry is measured from the file, never inferred from its generation request. */
export function playerMediaAspect(width: number, height: number): number | undefined {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : undefined;
}

export function playerMediaIdentity(scope: string, source: string, hash: string): string {
  return JSON.stringify([scope, source, hash]);
}
