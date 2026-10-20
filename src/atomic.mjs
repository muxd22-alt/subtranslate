import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file atomically: the destination either has its old contents or the
 * complete new contents, never a half written file.
 */
export function writeAtomic(file, data, encoding = 'utf8') {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.part`);
    try {
        fs.writeFileSync(tmp, data, encoding);
        fs.renameSync(tmp, file);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw err;
    }
}
