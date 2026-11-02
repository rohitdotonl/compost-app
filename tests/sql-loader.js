// Module loader hook: `import sql from './x.sql'` gives the file's text.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function load(url, context, next) {
  if (!url.endsWith('.sql')) return next(url, context);
  const text = await readFile(fileURLToPath(url), 'utf8');
  return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
}
