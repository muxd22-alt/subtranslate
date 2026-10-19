// @browsermt/bergamot-translator 0.4.9 ships worker/translator-worker.js written
// as CommonJS (it uses require/__dirname) inside a package that declares
// "type": "module". Node therefore refuses to load the worker with
// "require is not defined in ES module scope".
//
// Scoping the worker directory back to CommonJS fixes it without touching the
// package's sources. Re-run automatically on every install.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(here, '..', 'node_modules', '@browsermt', 'bergamot-translator', 'worker');

if (fs.existsSync(workerDir)) {
    fs.writeFileSync(path.join(workerDir, 'package.json'), '{"type":"commonjs"}\n');
    console.error('[subtranslate] scoped bergamot worker to CommonJS');
}
