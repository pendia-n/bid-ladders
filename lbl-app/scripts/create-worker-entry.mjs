import { copyFile, mkdir, writeFile } from 'node:fs/promises';

await mkdir('.svelte-kit/cloudflare', { recursive: true });
await copyFile('.svelte-kit/cloudflare/custom-entry.mjs', '.svelte-kit/cloudflare/_worker.js');
await writeFile('.svelte-kit/cloudflare/custom-entry.mjs', `import app from './_worker.js';
import { CarouselSlot } from '../../src/lib/server/carousel.ts';

export { CarouselSlot };
export default app;
`);
