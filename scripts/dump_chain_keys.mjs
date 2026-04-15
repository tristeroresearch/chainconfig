#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chainConfig } from '../chains.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
    let format = 'raw';
    let output = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--format' || arg === '-f') {
            format = argv[i + 1] || format;
            i++;
        } else if (arg.startsWith('--format=')) {
            format = arg.slice('--format='.length);
        } else if (arg === '--output' || arg === '-o') {
            output = argv[i + 1] || output;
            i++;
        } else if (arg.startsWith('--output=')) {
            output = arg.slice('--output='.length);
        }
    }

    return { format, output };
}

function normalizeFormat(format) {
    if (format === 'raw' || format === 'key') return 'raw';
    if (format === 'single' || format === "'key'" || format === 'single-quote' || format === 'single-quoted') return 'single';
    if (format === 'double' || format === '"key"' || format === 'double-quote' || format === 'double-quoted') return 'double';
    throw new Error(`Invalid --format value: ${format}. Use one of: raw, single, double`);
}

function renderKey(key, format) {
    if (format === 'single') return `'${key}'`;
    if (format === 'double') return `"${key}"`;
    return key;
}

async function main() {
    const { format: formatInput, output } = parseArgs(process.argv.slice(2));
    const format = normalizeFormat(formatInput);

    const keys = Object.keys(chainConfig).sort((a, b) => a.localeCompare(b));
    const lines = keys.map((k) => renderKey(k, format));
    const content = `${lines.join('\n')}\n`;

    if (output) {
        const outputPath = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);
        await fs.writeFile(outputPath, content, 'utf8');
        console.log(`Wrote ${keys.length} keys to ${outputPath} in format: ${format}`);
        return;
    }

    process.stdout.write(content);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
