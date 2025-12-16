#!/usr/bin/env node
/*
Master chain data aggregation script that combines data from:
- Existing chain configuration
- Gas.zip API (for new chains)
- Chainlist.org (for RPCs and explorers)
- CoinGecko (for platform IDs and gas asset IDs)

Usage:
  node chainconfig/scripts/aggregate_chain_data.mjs --help
  node chainconfig/scripts/aggregate_chain_data.mjs --output chains-complete.mjs
  node chainconfig/scripts/aggregate_chain_data.mjs --skip-coingecko
*/

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import https from 'https';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHAINS_FILE = path.join(__dirname, '..', 'chains.mjs');
const GASZIP_URL = 'https://backend.gas.zip/v2/chains';
const CHAINLIST_URL = 'https://chainlist.org/rpcs.json';
const COINGECKO_PLATFORMS_URL_FREE = 'https://api.coingecko.com/api/v3/asset_platforms';
const COINGECKO_PLATFORMS_URL_PRO = 'https://pro-api.coingecko.com/api/v3/asset_platforms';

/**
 * Validates and completes a chain object with all required schema fields
 * Returns { valid: true, chain: {...} } or { valid: false, error: '...', chain: {...} }
 */
function validateAndCompleteChain(chain) {
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    
    // Check for critical missing fields
    const errors = [];
    if (!chain.chainId) {
        errors.push('missing chainId');
    }
    if (!chain.key) {
        errors.push('missing key');
    }
    
    // If critical fields are missing, return invalid
    if (errors.length > 0) {
        return {
            valid: false,
            error: errors.join(', '),
            chain: chain,
        };
    }
    
    const validated = {
        key: chain.key || 'unknown',
        display: chain.display || chain.name || 'Unknown',
        currency: chain.currency || 'ETH',
        vmType: chain.vmType || 'EVM',
        chainId: chain.chainId,
        lzSrcId: chain.lzSrcId || 0,
        cgPlatformId: chain.cgPlatformId || null,
        cgGasAssetId: chain.cgGasAssetId || null,
        openOceanSupported: chain.openOceanSupported || false,
        openOceanChainCode: chain.openOceanChainCode || '',
        openOceanNativeAddress: chain.openOceanNativeAddress || zeroAddr,
        explorerUrls: Array.isArray(chain.explorerUrls) && chain.explorerUrls.length > 0
            ? chain.explorerUrls
            : (chain.explorerUrl ? [chain.explorerUrl] : ['']),
        defaultExplorerUrlIndex: chain.defaultExplorerUrlIndex || 0,
        rpcUrls: Array.isArray(chain.rpcUrls) && chain.rpcUrls.length > 0
            ? chain.rpcUrls
            : [],
        defaultRpcUrlIndex: chain.defaultRpcUrlIndex || 0,
        explorerApiUrl: chain.explorerApiUrl || undefined,
        addresses: {
            gasToken: chain.addresses?.gasToken || zeroAddr,
            wrappedGasToken: chain.addresses?.wrappedGasToken || zeroAddr,
            usdc: chain.addresses?.usdc || zeroAddr,
            usdt: chain.addresses?.usdt || zeroAddr,
            permit2: chain.addresses?.permit2 || zeroAddr,
            entryPoint: chain.addresses?.entryPoint || zeroAddr,
            trustedForwarder: chain.addresses?.trustedForwarder || zeroAddr,
            relayRouter: chain.addresses?.relayRouter || zeroAddr,
            messageTransmitter: chain.addresses?.messageTransmitter || zeroAddr,
            tokenMessenger: chain.addresses?.tokenMessenger || zeroAddr,
            create5: chain.addresses?.create5 || zeroAddr,
            multicall3: chain.addresses?.multicall3 || zeroAddr,
            ...(chain.addresses || {}),
        },
    };
    
    return {
        valid: true,
        chain: validated,
    };
}

/**
 * Fetches JSON from a URL using https module
 */
function fetchHttpsJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

/**
 * Fetches JSON using fetch API
 */
async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
}

/**
 * Load existing chain configuration
 */
async function loadExistingChains() {
    try {
        const configModule = await import(`file://${CHAINS_FILE}`);
        return configModule.chainConfig || {};
    } catch (e) {
        console.log(`⚠ Could not load existing chains: ${e.message}`);
        return {};
    }
}

/**
 * Fetch chains from gas.zip
 */
async function fetchGasZipChains() {
    try {
        const data = await fetchJson(GASZIP_URL);
        if (!data || !Array.isArray(data.chains)) {
            throw new Error('Unexpected response format from gas.zip');
        }
        return data.chains;
    } catch (e) {
        console.error(`✗ Error fetching gas.zip data: ${e.message}`);
        return [];
    }
}

/**
 * Fetch chains from chainlist.org
 */
async function fetchChainlistData() {
    try {
        return await fetchHttpsJson(CHAINLIST_URL);
    } catch (e) {
        console.error(`✗ Error fetching chainlist data: ${e.message}`);
        return [];
    }
}

/**
 * Fetch CoinGecko platforms
 */
async function fetchCoinGeckoPlatforms(useProApi = false) {
    const apiKey = process.env.COINGECKO_API_KEY || process.env.CG_API_KEY;
    const url = (useProApi || apiKey) ? COINGECKO_PLATFORMS_URL_PRO : COINGECKO_PLATFORMS_URL_FREE;
    const headers = apiKey ? { 'x-cg-pro-api-key': apiKey } : {};
    
    try {
        const data = await fetchJson(url, { headers });
        return data;
    } catch (e) {
        console.error(`✗ Error fetching CoinGecko platforms: ${e.message}`);
        return [];
    }
}

/**
 * Slugify name to key
 */
function slugifyNameToKey(name) {
    if (!name) return null;
    return String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_');
}

/**
 * Extract HTTPS RPC URLs from chainlist data
 */
function extractRpcUrls(chainlistRpcs) {
    const urls = [];
    for (const rpc of chainlistRpcs) {
        const url = typeof rpc === 'string' ? rpc : rpc.url;
        const tracking = typeof rpc === 'object' ? rpc.tracking : undefined;
        
        if (!url || !url.startsWith('https://')) continue;
        if (tracking === 'yes' || tracking === 'limited') continue;
        
        urls.push(url);
    }
    return urls;
}

/**
 * Extract explorer URLs from chainlist data
 */
function extractExplorerUrls(chainlistExplorers) {
    if (!chainlistExplorers || !Array.isArray(chainlistExplorers)) {
        return [];
    }
    return chainlistExplorers
        .map(explorer => explorer.url)
        .filter(url => url && url.startsWith('https://'));
}

/**
 * Merge chain data from multiple sources
 * Returns { valid: true, chain: {...} } or { valid: false, error: '...', chain: {...} }
 */
function mergeChainData(existing, gaszip, chainlist, coingecko) {
    const merged = { ...existing };
    
    // Merge RPCs from chainlist
    if (chainlist) {
        const chainlistRpcs = extractRpcUrls(chainlist.rpc || []);
        const existingRpcs = new Set(merged.rpcUrls || []);
        const newRpcs = chainlistRpcs.filter(url => !existingRpcs.has(url));
        
        if (newRpcs.length > 0) {
            merged.rpcUrls = [...(merged.rpcUrls || []), ...newRpcs];
        }
        
        // Merge explorers from chainlist
        const chainlistExplorers = extractExplorerUrls(chainlist.explorers || []);
        const existingExplorerUrls = Array.isArray(merged.explorerUrls) 
            ? merged.explorerUrls 
            : (merged.explorerUrl ? [merged.explorerUrl] : []);
        const existingExplorerSet = new Set(existingExplorerUrls);
        const newExplorers = chainlistExplorers.filter(url => !existingExplorerSet.has(url));
        
        if (newExplorers.length > 0) {
            merged.explorerUrls = [...existingExplorerUrls, ...newExplorers];
        }
    }
    
    // Add CoinGecko data
    if (coingecko) {
        merged.cgPlatformId = coingecko.id;
        merged.cgGasAssetId = coingecko.native_coin_id;
    }
    
    // Ensure explorerUrls is array
    if (!Array.isArray(merged.explorerUrls) && merged.explorerUrl) {
        merged.explorerUrls = [merged.explorerUrl];
    }
    
    return validateAndCompleteChain(merged);
}

/**
 * Save incomplete chains to a separate file for manual fixing
 */
async function saveIncompleteChains(incompleteChains, outputDir) {
    const outputPath = path.join(outputDir, 'chains-incomplete.json');
    const output = {
        generatedAt: new Date().toISOString(),
        totalIncomplete: incompleteChains.length,
        chains: incompleteChains.map(item => ({
            key: item.key,
            error: item.error,
            data: item.chain,
        })),
    };
    
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    return outputPath;
}

/**
 * Format a chain object as JavaScript code
 */
function formatChainObject(key, chain, indent = '    ') {
    const lines = [
        `${indent}${key}: {`,
        `${indent}    key: "${chain.key}",`,
        `${indent}    display: "${chain.display}",`,
        `${indent}    currency: "${chain.currency}",`,
        `${indent}    vmType: "${chain.vmType}",`,
        `${indent}    chainId: ${chain.chainId},`,
        `${indent}    lzSrcId: ${chain.lzSrcId},`,
        `${indent}    cgPlatformId: ${chain.cgPlatformId === null ? 'null' : `"${chain.cgPlatformId}"`},`,
        `${indent}    cgGasAssetId: ${chain.cgGasAssetId === null ? 'null' : `"${chain.cgGasAssetId}"`},`,
        `${indent}    openOceanSupported: ${chain.openOceanSupported},`,
        `${indent}    openOceanChainCode: "${chain.openOceanChainCode}",`,
        `${indent}    openOceanNativeAddress: "${chain.openOceanNativeAddress}",`,
    ];
    
    // Add explorerUrls
    lines.push(`${indent}    explorerUrls: [`);
    for (const url of chain.explorerUrls) {
        lines.push(`${indent}        "${url}",`);
    }
    lines.push(`${indent}    ],`);
    lines.push(`${indent}    defaultExplorerUrlIndex: ${chain.defaultExplorerUrlIndex},`);
    
    // Add explorerApiUrl if exists
    if (chain.explorerApiUrl) {
        lines.push(`${indent}    explorerApiUrl: "${chain.explorerApiUrl}",`);
    }
    
    // Add rpcUrls
    lines.push(`${indent}    rpcUrls: [`);
    for (const url of chain.rpcUrls) {
        lines.push(`${indent}        "${url}",`);
    }
    lines.push(`${indent}    ],`);
    lines.push(`${indent}    defaultRpcUrlIndex: ${chain.defaultRpcUrlIndex},`);
    
    // Add addresses
    lines.push(`${indent}    addresses: {`);
    
    const standardFields = [
        'gasToken', 'wrappedGasToken', 'usdc', 'usdt',
        'permit2', 'entryPoint', 'trustedForwarder', 'relayRouter',
        'messageTransmitter', 'tokenMessenger', 'create5', 'multicall3'
    ];
    
    for (const field of standardFields) {
        if (chain.addresses[field]) {
            lines.push(`${indent}        ${field}: "${chain.addresses[field]}",`);
        }
    }
    
    for (const [addrKey, value] of Object.entries(chain.addresses)) {
        if (!standardFields.includes(addrKey)) {
            lines.push(`${indent}        ${addrKey}: "${value}",`);
        }
    }
    
    lines.push(`${indent}    },`);
    lines.push(`${indent}},`);
    lines.push('');
    
    return lines.join('\n');
}

/**
 * Main aggregation function
 */
async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('output', {
            alias: 'o',
            type: 'string',
            description: 'Output filename',
            default: 'chains-complete.mjs',
        })
        .option('skip-gaszip', {
            type: 'boolean',
            description: 'Skip fetching new chains from gas.zip',
            default: false,
        })
        .option('skip-chainlist', {
            type: 'boolean',
            description: 'Skip fetching RPCs from chainlist.org',
            default: false,
        })
        .option('skip-coingecko', {
            type: 'boolean',
            description: 'Skip fetching CoinGecko platform IDs',
            default: false,
        })
        .option('include-testnets', {
            alias: 't',
            type: 'boolean',
            description: 'Include testnet chains from gas.zip',
            default: false,
        })
        .help()
        .alias('help', 'h')
        .argv;

    console.log('='.repeat(80));
    console.log('MASTER CHAIN DATA AGGREGATOR');
    console.log('='.repeat(80));
    console.log('');

    // Load existing chains
    console.log('1. Loading existing chain configuration...');
    const existingChains = await loadExistingChains();
    const existingChainIds = new Set(Object.values(existingChains).map(c => c.chainId));
    console.log(`   ✓ Loaded ${Object.keys(existingChains).length} existing chains\n`);

    // Fetch gas.zip data
    let gaszipChains = [];
    let gaszipMap = new Map();
    if (!argv.skipGaszip) {
        console.log('2. Fetching chains from gas.zip...');
        gaszipChains = await fetchGasZipChains();
        console.log(`   ✓ Fetched ${gaszipChains.length} chains from gas.zip\n`);
        
        // Filter and map
        gaszipChains
            .filter(c => argv.includeTestnets ? true : !!c.mainnet)
            .forEach(c => {
                if (c.chain) {
                    gaszipMap.set(c.chain, c);
                }
            });
    } else {
        console.log('2. Skipping gas.zip (--skip-gaszip)\n');
    }

    // Fetch chainlist data
    let chainlistData = [];
    let chainlistMap = new Map();
    if (!argv.skipChainlist) {
        console.log('3. Fetching RPCs from chainlist.org...');
        chainlistData = await fetchChainlistData();
        console.log(`   ✓ Fetched ${chainlistData.length} chains from chainlist.org\n`);
        
        chainlistData.forEach(c => {
            if (c.chainId) {
                chainlistMap.set(c.chainId, c);
            }
        });
    } else {
        console.log('3. Skipping chainlist.org (--skip-chainlist)\n');
    }

    // Fetch CoinGecko data
    let coingeckoPlatforms = [];
    let coingeckoMap = new Map();
    if (!argv.skipCoingecko) {
        console.log('4. Fetching CoinGecko platform IDs...');
        coingeckoPlatforms = await fetchCoinGeckoPlatforms();
        console.log(`   ✓ Fetched ${coingeckoPlatforms.length} platforms from CoinGecko\n`);
        
        coingeckoPlatforms.forEach(p => {
            if (p.chain_identifier !== null && p.chain_identifier !== undefined) {
                coingeckoMap.set(p.chain_identifier, p);
            }
        });
    } else {
        console.log('4. Skipping CoinGecko (--skip-coingecko)\n');
    }

    // Merge all data
    console.log('5. Merging chain data...\n');
    const mergedChains = {};
    const incompleteChains = [];
    let updatedCount = 0;
    let newRpcsTotal = 0;
    let newExplorersTotal = 0;
    let cgMatchedCount = 0;
    let invalidCount = 0;

    // Process existing chains
    for (const [key, chain] of Object.entries(existingChains)) {
        const chainlist = chainlistMap.get(chain.chainId);
        const coingecko = coingeckoMap.get(chain.chainId);
        
        const originalRpcCount = (chain.rpcUrls || []).length;
        const originalExplorerUrls = Array.isArray(chain.explorerUrls) 
            ? chain.explorerUrls 
            : (chain.explorerUrl ? [chain.explorerUrl] : []);
        const originalExplorerCount = originalExplorerUrls.length;
        
        const result = mergeChainData(chain, null, chainlist, coingecko);
        
        if (!result.valid) {
            // Chain has validation errors - save for manual fixing
            console.log(`   ✗ ${(chain.display || key).padEnd(30)} → INVALID: ${result.error}`);
            incompleteChains.push({
                key: key,
                error: result.error,
                chain: result.chain,
            });
            invalidCount++;
            continue;
        }
        
        const merged = result.chain;
        const newRpcs = merged.rpcUrls.length - originalRpcCount;
        const newExplorers = merged.explorerUrls.length - originalExplorerCount;
        
        if (newRpcs > 0 || newExplorers > 0 || coingecko) {
            const updates = [];
            if (newRpcs > 0) updates.push(`+${newRpcs} RPCs`);
            if (newExplorers > 0) updates.push(`+${newExplorers} explorers`);
            if (coingecko) {
                updates.push(`CoinGecko: ${coingecko.id}`);
                cgMatchedCount++;
            }
            console.log(`   ${chain.display.padEnd(30)} → ${updates.join(', ')}`);
            updatedCount++;
            newRpcsTotal += newRpcs;
            newExplorersTotal += newExplorers;
        }
        
        mergedChains[key] = merged;
    }

    console.log('');
    console.log(`   ✓ Processed ${Object.keys(existingChains).length} chains`);
    console.log(`   • Valid chains: ${Object.keys(mergedChains).length}`);
    console.log(`   • Invalid chains: ${invalidCount}`);
    console.log(`   • Updated chains: ${updatedCount}`);
    console.log(`   • Total new RPCs: ${newRpcsTotal}`);
    console.log(`   • Total new explorers: ${newExplorersTotal}`);
    console.log(`   • CoinGecko matches: ${cgMatchedCount}/${Object.keys(existingChains).length}`);

    // Define output path
    const outputPath = path.join(__dirname, '..', argv.output);

    // Save incomplete chains if any
    if (incompleteChains.length > 0) {
        console.log('\n   ⚠ Saving incomplete chains for manual fixing...');
        const incompletePath = await saveIncompleteChains(incompleteChains, path.dirname(outputPath));
        console.log(`   ✓ Incomplete chains saved to: ${path.basename(incompletePath)}`);
    }

    // Generate output
    console.log('\n6. Generating output file...\n');
    const outputLines = [
        '// Auto-generated complete chain configuration',
        `// Generated on ${new Date().toISOString()}`,
        '// Aggregated from: existing config, gas.zip, chainlist.org, CoinGecko',
        '// Each chain has a stable key usable as chainConfig[key].variable',
        '// rpcUrls is an array, with defaultRpcUrlIndex selecting the preferred one',
        '// explorerUrls is an array, with defaultExplorerUrlIndex selecting the preferred one',
        '',
        '',
        'export const chainConfig = {',
    ];

    for (const [key, chain] of Object.entries(mergedChains)) {
        outputLines.push(formatChainObject(key, chain));
    }

    outputLines.push('};');
    outputLines.push('');
    outputLines.push('// All chains as an array');
    outputLines.push('export const configuredChains = Object.values(chainConfig);');
    outputLines.push('');
    outputLines.push('// Get chains by keys');
    outputLines.push('export function getChainsByKeys(keys) {');
    outputLines.push('    if (!Array.isArray(keys)) return [];');
    outputLines.push('    return keys.map(key => chainConfig[key]).filter(Boolean);');
    outputLines.push('}');
    outputLines.push('');
    outputLines.push('// Get RPC URL for a chain');
    outputLines.push('export function getRpcUrl(chainKeyOrObject) {');
    outputLines.push('    const chain = typeof chainKeyOrObject === "string" ? chainConfig[chainKeyOrObject] : chainKeyOrObject;');
    outputLines.push('    if (!chain) return null;');
    outputLines.push('    if (!chain.rpcUrls || chain.rpcUrls.length === 0) return null;');
    outputLines.push('    const index = chain.defaultRpcUrlIndex || 0;');
    outputLines.push('    return chain.rpcUrls[index] || chain.rpcUrls[0];');
    outputLines.push('}');
    outputLines.push('');
    outputLines.push('// Get explorer URL for a chain');
    outputLines.push('export function getExplorerUrl(chainKeyOrObject) {');
    outputLines.push('    const chain = typeof chainKeyOrObject === "string" ? chainConfig[chainKeyOrObject] : chainKeyOrObject;');
    outputLines.push('    if (!chain) return null;');
    outputLines.push('    if (!Array.isArray(chain.explorerUrls) || chain.explorerUrls.length === 0) return null;');
    outputLines.push('    const idx = Number.isInteger(chain.defaultExplorerUrlIndex) ? chain.defaultExplorerUrlIndex : 0;');
    outputLines.push('    return chain.explorerUrls[Math.max(0, Math.min(idx, chain.explorerUrls.length - 1))];');
    outputLines.push('}');
    outputLines.push('');

    await fs.writeFile(outputPath, outputLines.join('\n'), 'utf-8');
    
    console.log(`   ✓ Output saved to: ${outputPath}`);
    console.log('');
    console.log('='.repeat(80));
    console.log('✓ AGGREGATION COMPLETE!');
    console.log('='.repeat(80));
    console.log('');
    console.log('Summary:');
    console.log(`  • Total chains processed: ${Object.keys(existingChains).length}`);
    console.log(`  • Valid chains: ${Object.keys(mergedChains).length}`);
    console.log(`  • Invalid chains: ${invalidCount}${invalidCount > 0 ? ' (see chains-incomplete.json)' : ''}`);
    console.log(`  • Updated chains: ${updatedCount}`);
    console.log(`  • New RPCs added: ${newRpcsTotal}`);
    console.log(`  • New explorers added: ${newExplorersTotal}`);
    console.log(`  • CoinGecko matches: ${cgMatchedCount}`);
    console.log('');
    
    if (invalidCount > 0) {
        console.log('⚠ WARNING: Some chains have validation errors.');
        console.log('  Review chains-incomplete.json and fix manually.');
        console.log('');
    }
}

main().catch(error => {
    console.error('\n✗ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
});
