#!/usr/bin/env node
import { main } from '../src/qwen-cli.mjs';

main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(err => {
        process.stderr.write(`subqwen: ${(err && err.stack) || err}\n`);
        process.exitCode = 1;
    });
