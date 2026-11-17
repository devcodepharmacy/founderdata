// Installs this checkout's edition for every test file (vitest.config.ts setupFiles), as the Worker's entry does
// (src/worker/index.ts), so a test that calls a core module directly sees Pro in a Pro checkout and none in core.
// The import runs in beforeAll, after the test file's own imports, so its vi.mock calls apply to Pro's modules too.
import { beforeAll } from 'vitest';
import { installPro } from '../src/worker/pro-hooks';

beforeAll(async () => {
  const { pro } = await import('../src/worker/edition');
  installPro(pro);
});
