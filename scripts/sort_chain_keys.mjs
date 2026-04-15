#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHAINS_FILE = path.resolve(__dirname, '../chains.mjs');

function parseArgs(argv) {
    return {
        write: argv.includes('--write'),
        check: argv.includes('--check'),
    };
}

function isIdentChar(ch) {
    return /[A-Za-z0-9_$]/.test(ch);
}

function findObjectRange(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) {
        throw new Error(`Could not find marker: ${marker}`);
    }

    const openBraceIndex = source.indexOf('{', markerIndex);
    if (openBraceIndex === -1) {
        throw new Error('Could not find opening brace for chainConfig object');
    }

    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;
    let depth = 0;

    for (let i = openBraceIndex; i < source.length; i++) {
        const c = source[i];
        const n = source[i + 1];

        if (inLineComment) {
            if (c === '\n') inLineComment = false;
            continue;
        }

        if (inBlockComment) {
            if (c === '*' && n === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (inSingle) {
            if (!escaped && c === '\\') {
                escaped = true;
            } else if (!escaped && c === "'") {
                inSingle = false;
            } else {
                escaped = false;
            }
            continue;
        }

        if (inDouble) {
            if (!escaped && c === '\\') {
                escaped = true;
            } else if (!escaped && c === '"') {
                inDouble = false;
            } else {
                escaped = false;
            }
            continue;
        }

        if (inTemplate) {
            if (!escaped && c === '\\') {
                escaped = true;
            } else if (!escaped && c === '`') {
                inTemplate = false;
            } else {
                escaped = false;
            }
            continue;
        }

        if (c === '/' && n === '/') {
            inLineComment = true;
            i++;
            continue;
        }

        if (c === '/' && n === '*') {
            inBlockComment = true;
            i++;
            continue;
        }

        if (c === "'") {
            inSingle = true;
            continue;
        }
        if (c === '"') {
            inDouble = true;
            continue;
        }
        if (c === '`') {
            inTemplate = true;
            continue;
        }

        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) {
                return { openBraceIndex, closeBraceIndex: i };
            }
        }
    }

    throw new Error('Unbalanced braces while parsing chainConfig object');
}

function splitTopLevelEntries(body) {
    const entries = [];

    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    let braceDepth = 0;
    let bracketDepth = 0;
    let parenDepth = 0;

    let entryStart = -1;

    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        const n = body[i + 1];

        if (inLineComment) {
            if (c === '\n') inLineComment = false;
            continue;
        }

        if (inBlockComment) {
            if (c === '*' && n === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (inSingle) {
            if (!escaped && c === '\\') {
                escaped = true;
            } else if (!escaped && c === "'") {
                inSingle = false;
            } else {
                escaped = false;
            }
            continue;
        }

        if (inDouble) {
            if (!escaped && c === '\\') {
                escaped = true;
            } else if (!escaped && c === '"') {
                inDouble = false;
            } else {
                escaped = false;
            }
            continue;
        }

        if (inTemplate) {
            if (!escaped && c === '\\') {
                escaped = true;
            } else if (!escaped && c === '`') {
                inTemplate = false;
            } else {
                escaped = false;
            }
            continue;
        }

        if (c === '/' && n === '/') {
            inLineComment = true;
            i++;
            continue;
        }

        if (c === '/' && n === '*') {
            inBlockComment = true;
            i++;
            continue;
        }

        if (c === "'") {
            inSingle = true;
            continue;
        }
        if (c === '"') {
            inDouble = true;
            continue;
        }
        if (c === '`') {
            inTemplate = true;
            continue;
        }

        if (entryStart === -1 && !/\s/.test(c)) {
            entryStart = i;
        }

        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth--;
        else if (c === '[') bracketDepth++;
        else if (c === ']') bracketDepth--;
        else if (c === '(') parenDepth++;
        else if (c === ')') parenDepth--;

        if (
            entryStart !== -1 &&
            c === ',' &&
            braceDepth === 0 &&
            bracketDepth === 0 &&
            parenDepth === 0
        ) {
            entries.push(body.slice(entryStart, i + 1));
            entryStart = -1;
        }
    }

    if (entryStart !== -1) {
        const tail = body.slice(entryStart).trim();
        if (tail) entries.push(body.slice(entryStart));
    }

    return entries.map((entry) => entry.trim()).filter(Boolean);
}

function extractEntryKey(entry) {
    let i = 0;
    while (i < entry.length && /\s/.test(entry[i])) i++;

    if (entry[i] === '"' || entry[i] === "'") {
        const quote = entry[i++];
        const start = i;
        while (i < entry.length && entry[i] !== quote) i++;
        if (i >= entry.length)
            throw new Error(`Could not parse key in entry: ${entry.slice(0, 80)}...`);
        return entry.slice(start, i);
    }

    const start = i;
    while (i < entry.length && isIdentChar(entry[i])) i++;
    if (i === start) throw new Error(`Could not parse key in entry: ${entry.slice(0, 80)}...`);
    return entry.slice(start, i);
}

function rebuildBody(sortedEntries) {
    if (sortedEntries.length === 0) {
        return '\n';
    }
    return `\n${sortedEntries.join('\n\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const source = await fs.readFile(CHAINS_FILE, 'utf8');
    const marker = 'export const chainConfig = {';
    const { openBraceIndex, closeBraceIndex } = findObjectRange(source, marker);

    const body = source.slice(openBraceIndex + 1, closeBraceIndex);
    const entries = splitTopLevelEntries(body);

    const keyed = entries.map((entry) => ({ key: extractEntryKey(entry), entry }));
    const sorted = [...keyed].sort((a, b) => a.key.localeCompare(b.key));

    const alreadySorted = keyed.every((item, idx) => item.key === sorted[idx].key);

    if (args.check) {
        if (!alreadySorted) {
            console.error('chainconfig/chains.mjs keys are not alphabetically ordered.');
            process.exit(1);
        }
        console.log('chainconfig/chains.mjs keys are alphabetically ordered.');
        return;
    }

    if (!args.write) {
        console.log('No action taken. Use --check or --write.');
        return;
    }

    if (alreadySorted) {
        console.log('No changes needed. chainconfig/chains.mjs keys are already sorted.');
        return;
    }

    const newBody = rebuildBody(sorted.map((x) => x.entry));
    const updated = source.slice(0, openBraceIndex + 1) + newBody + source.slice(closeBraceIndex);

    await fs.writeFile(CHAINS_FILE, updated, 'utf8');
    console.log(`Sorted ${entries.length} chain keys in ${CHAINS_FILE}.`);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
