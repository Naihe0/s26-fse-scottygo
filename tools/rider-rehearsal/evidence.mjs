import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function recordEvidence(result) {
  const index = process.argv.indexOf('--evidence-file');
  if (index >= 0) {
    const target = process.argv[index + 1];
    if (!target) throw new Error('--evidence-file requires a path');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(result, null, 2));
  }
  console.log(
    JSON.stringify(
      index >= 0
        ? {
            status: result.status,
            engine: result.engine,
            suites: result.suites,
            assertions: result.assertions,
            nativeHostTests: result.nativeHostTests,
            flowIds: result.flows?.map((f) => f.flowId),
            useCases: result.useCases?.map((u) => u.id),
            evidence: process.argv[index + 1]
          }
        : result
    )
  );
}
