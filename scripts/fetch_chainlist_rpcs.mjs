#!/usr/bin/env node
import https from 'https';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHAINLIST_API_URL = 'https://chainlist.org/rpcs.json';
const CHAINS_PATH = join(__dirname, '..', 'chains.mjs');

/**
 * Validates and completes a chain object with all required schema fields
 */
function validateAndCompleteChain(chain) {
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    
    return {
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
}

/**
 * Fetches JSON from a URL using https module
 */
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

/**
 * Loads existing chains from chains.mjs
 */
async function loadExistingChains() {
    try {
        const module = await import(CHAINS_PATH);
        return module.chainConfig;
    } catch (e) {
        throw new Error(`Could not load existing chains: ${e.message}`);
    }
}

/**
 * Extracts HTTPS RPC URLs from chainlist data with good tracking
 * Only includes URLs with tracking: "none" or no tracking field (assumed safe)
 */
function extractRpcUrls(chainlistRpcs) {
    const urls = [];
    for (const rpc of chainlistRpcs) {
        const url = typeof rpc === 'string' ? rpc : rpc.url;
        const tracking = typeof rpc === 'object' ? rpc.tracking : undefined;
        
        // Only include HTTPS URLs
        if (!url || !url.startsWith('https://')) {
            continue;
        }
        
        // Skip URLs with tracking: "yes" or "limited"
        if (tracking === 'yes' || tracking === 'limited') {
            continue;
        }
        
        urls.push(url);
    }
    return urls;
}

/**
 * Extracts explorer URLs from chainlist data
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
 * Merges RPCs and explorers from chainlist into existing chain config
 */
function mergeChainData(existingChain, chainlistChain) {
    // Extract new RPCs
    const chainlistRpcs = extractRpcUrls(chainlistChain.rpc || []);
    const existingRpcs = new Set(existingChain.rpcUrls || []);
    const newRpcs = chainlistRpcs.filter(url => !existingRpcs.has(url));
    
    // Extract new explorers
    const chainlistExplorers = extractExplorerUrls(chainlistChain.explorers || []);
    const existingExplorerUrls = Array.isArray(existingChain.explorerUrls) 
        ? existingChain.explorerUrls 
        : (existingChain.explorerUrl ? [existingChain.explorerUrl] : []);
    
    // Create list of all explorer URLs (existing + new ones)
    const allExplorerUrls = [...existingExplorerUrls];
    const existingExplorerSet = new Set(existingExplorerUrls);
    
    for (const url of chainlistExplorers) {
        if (!existingExplorerSet.has(url)) {
            allExplorerUrls.push(url);
            existingExplorerSet.add(url);
        }
    }
    
    // Merge and validate complete schema
    const merged = {
        ...existingChain,
        rpcUrls: [...existingChain.rpcUrls, ...newRpcs],
        explorerUrls: allExplorerUrls,
        defaultExplorerUrlIndex: existingChain.defaultExplorerUrlIndex || 0,
    };
    
    return validateAndCompleteChain(merged);
}

/**
 * Formats a chain object as JavaScript code
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
    
    // Add explorerUrls array
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
    
    // Add addresses - ensure proper ordering
    lines.push(`${indent}    addresses: {`);
    
    // Standard address fields in order
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
    
    // Add any custom address fields
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
 * Main function
 */
async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('output', {
            alias: 'o',
            type: 'string',
            description: 'Output filename',
            default: 'chains-updated.mjs',
        })
        .option('validate-only', {
            alias: 'v',
            type: 'boolean',
            description: 'Only validate schema without merging',
            default: false,
        })
        .help()
        .alias('help', 'h')
        .argv;

    console.log('='.repeat(80));
    console.log('CHAINLIST.ORG RPC FETCHER');
    console.log('='.repeat(80));
    console.log('');

    console.log('Fetching chainlist.org RPC data...');
    const chainlistData = await fetchJson(CHAINLIST_API_URL);
    
    console.log(`Found ${chainlistData.length} chains from chainlist.org`);
    
    console.log('Loading existing chains from config...');
    const existingChains = await loadExistingChains();
    const existingChainIds = Object.values(existingChains).map(c => c.chainId);
    console.log(`Found ${existingChainIds.length} existing chains in config\n`);
    
    // Build chainId -> chainlist data map
    const chainlistMap = new Map();
    for (const chain of chainlistData) {
        if (chain.chainId) {
            chainlistMap.set(chain.chainId, chain);
        }
    }
    
    // Validate or merge data
    if (argv.validateOnly) {
        console.log('Validating chain schema...');
        let validCount = 0;
        let invalidCount = 0;
        
        for (const [key, chain] of Object.entries(existingChains)) {
            try {
                validateAndCompleteChain(chain);
                validCount++;
            } catch (e) {
                console.log(`  ✗ ${key}: ${e.message}`);
                invalidCount++;
            }
        }
        
        console.log(`\n✓ Validation complete: ${validCount} valid, ${invalidCount} invalid\n`);
        return;
    }
    
    // Merge data
    console.log('Merging RPC and explorer data...');
    const updatedChains = {};
    let mergedCount = 0;
    let totalNewRpcs = 0;
    let totalNewExplorers = 0;
    
    for (const [key, chain] of Object.entries(existingChains)) {
        const chainlistChain = chainlistMap.get(chain.chainId);
        
        if (chainlistChain) {
            const originalRpcCount = (chain.rpcUrls || []).length;
            const originalExplorerUrls = Array.isArray(chain.explorerUrls) 
                ? chain.explorerUrls 
                : (chain.explorerUrl ? [chain.explorerUrl] : []);
            const originalExplorerCount = originalExplorerUrls.length;
            
            const merged = mergeChainData(chain, chainlistChain);
            
            const newRpcCount = merged.rpcUrls.length - originalRpcCount;
            const newExplorerCount = merged.explorerUrls.length - originalExplorerCount;
            
            if (newRpcCount > 0 || newExplorerCount > 0) {
                console.log(`  ${chain.display} (${chain.chainId}): +${newRpcCount} RPCs, +${newExplorerCount} explorers`);
                mergedCount++;
                totalNewRpcs += newRpcCount;
                totalNewExplorers += newExplorerCount;
            }
            
            updatedChains[key] = merged;
        } else {
            // No chainlist data, validate and complete with schema
            updatedChains[key] = validateAndCompleteChain(chain);
        }
    }
    
    console.log(`\n✓ Merged data for ${mergedCount} chains`);
    console.log(`  Total new RPCs: ${totalNewRpcs}`);
    console.log(`  Total new explorers: ${totalNewExplorers}`);
    
    // Generate output file
    console.log('\nGenerating updated chains file...');
    const outputPath = join(__dirname, '..', argv.output);
    const outputLines = [
        '// Auto-generated chain configuration',
        `// Generated on ${new Date().toISOString()}`,
        '// Updated with additional RPCs and explorers from chainlist.org',
        '// Each chain has a stable key usable as chainConfig[key].variable',
        '// rpcUrls is an array, with defaultRpcUrlIndex selecting the preferred one',
        '// explorerUrls is an array, with defaultExplorerUrlIndex selecting the preferred one',
        '',
        '',
        'export const chainConfig = {',
    ];
    
    for (const [key, chain] of Object.entries(updatedChains)) {
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
    console.log(`\n✓ Updated chains saved to ${outputPath}`);
    console.log('\nReview the file and replace chains.mjs if everything looks good.');
    
    console.log('');
    console.log('='.repeat(80));
    console.log('✓ Complete!');
    console.log('='.repeat(80));
}

main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
});
