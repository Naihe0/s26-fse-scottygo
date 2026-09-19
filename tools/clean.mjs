import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed repository-relative targets work on Windows, macOS, and Linux.
const root = fileURLToPath(new URL('../', import.meta.url));
const targets = process.argv.includes('--all')
  ? ['.dist', '.parcel-cache']
  : ['.dist'];
for (const target of targets)
  rmSync(resolve(root, target), { recursive: true, force: true });
