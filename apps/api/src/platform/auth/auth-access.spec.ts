import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// A new internal controller must not accidentally lose its Worker guard or bypass business auth.
describe('independent authentication controller declarations', () => {
  it('keeps every worker bypass adjacent to a worker token guard', () => {
    const files = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(resolve(directory, entry.name))
          : [resolve(directory, entry.name)],
      );
    const controllers = files(resolve(__dirname, '../..')).filter((path) =>
      path.endsWith('.controller.ts'),
    );
    let workers = 0;
    for (const path of controllers) {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('internal/workers/')) continue;
      const declarations = source.split(/@Controller\(/).slice(1);
      for (const declaration of declarations) {
        const header = declaration.split('export class')[0]!;
        if (!header.includes('internal/workers/')) continue;
        workers++;
        expect(header, relative(process.cwd(), path)).toContain("@AuthAccess('independent')");
        expect(header, relative(process.cwd(), path)).toMatch(/@UseGuards\(\w+WorkerGuard\)/);
      }
    }
    expect(workers).toBeGreaterThan(10);
  });
});
