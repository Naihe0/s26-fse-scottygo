import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const paths = execFileSync('git', ['ls-files', '-z'], { cwd })
  .toString()
  .split('\0')
  .filter(Boolean);
const seen = new Set();
const invalid = paths.filter((name) => {
  const lower = name.toLowerCase();
  const collision = seen.has(lower);
  seen.add(lower);
  return (
    collision ||
    name
      .split('/')
      .some(
        (part) =>
          /[<>:"\\|?*\u0000-\u001f]|[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  );
});
if (invalid.length) {
  console.error(
    'Tracked paths cannot be checked out safely on Windows:\n' +
      invalid.join('\n')
  );
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${paths.length} tracked paths for Windows compatibility.`
  );
}
