// Renders demo-brands/logos/*.svg to PNG (the API refuses SVG uploads: stored-XSS risk).
// Needs `rsvg-convert` (librsvg: `brew install librsvg` / `apt install librsvg2-bin`).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo-brands/logos');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
  const out = path.join(dir, file.replace(/\.svg$/, '.png'));
  execFileSync('rsvg-convert', ['--height', '128', '--output', out, path.join(dir, file)]);
  process.stdout.write(`${path.relative(process.cwd(), out)}\n`);
}
