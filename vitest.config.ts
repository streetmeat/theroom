import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default defineWorkersConfig(async () => {
  const outDir = '.mf';
  const outFile = join(outDir, 'worker.mjs');
  mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: ['src/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: outFile,
    sourcemap: false,
    target: 'es2022',
  });

  return {
    test: {
      include: ['test/**/*.test.ts'],
      poolOptions: {
        workers: {
          main: outFile,
          miniflare: {
            compatibilityDate: '2024-11-01',
            modules: true,
            durableObjects: {
              ROOM_DO: { className: 'RoomDO' },
            },
            r2Buckets: { ROOM_BUCKET: 'room-bucket' },
            bindings: {
              FAL_KEY: 'test-fal-key',
            },
          },
        },
      },
    },
  };
});
