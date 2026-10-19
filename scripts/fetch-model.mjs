#!/usr/bin/env node
import { fetchModel } from '../src/fetch-model.mjs';
import { defaultModelDir } from '../src/engine.mjs';

const dir = process.argv[2] || defaultModelDir();

fetchModel(dir, { log: console.error })
    .then(() => process.exitCode = 0)
    .catch(err => {
        console.error(`fetch-model: ${err.message}`);
        process.exitCode = 1;
    });
