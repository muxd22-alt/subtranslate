#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(err => {
        process.stderr.write(`subtranslate: ${(err && err.stack) || err}\n`);
        process.exitCode = 1;
    });
