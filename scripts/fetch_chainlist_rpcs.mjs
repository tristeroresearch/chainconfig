#!/usr/bin/env node
import https from 'https';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHAINLIST_API_URL = 'https://chainlist.org/rpcs.json';
const CHAINS_PATH = join(__dirname, '..', 'chains.mjs');
const OUTPUT_PATH = join(__dirname, '..', 'chains-updated.mjs');

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
    const existingExplorerUrl = existingChain.explorerUrl;
    
    // Create list of all explorer URLs (existing + new ones)
    const allExplorerUrls = [existingExplorerUrl];
    const existingExplorerSet = new Set([existingExplorerUrl]);
    
    for (const url of chainlistExplorers) {
        if (!existingExplorerSet.has(url)) {
            allExplorerUrls.push(url);
            existingExplorerSet.add(url);
        }
    }
    
    return {
        ...existingChain,
        rpcUrls: [...existingChain.rpcUrls, ...newRpcs],
        explorerUrls: allExplorerUrls,
        defaultExplorerUrlIndex: 0, // Keep the existing one as default
    };
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
    ];
    
    // Add explorerUrls array
    lines.push(`${indent}    explorerUrls: [`);
    for (const url of chain.explorerUrls) {
        lines.push(`${indent}        "${url}",`);
    }
    lines.push(`${indent}    ],`);
    lines.push(`${indent}    defaultExplorerUrlIndex: ${chain.defaultExplorerUrlIndex},`);
    
    // Add deprecated explorerUrl for backwards compatibility
    lines.push(`${indent}    explorerUrl: "${chain.explorerUrls[chain.defaultExplorerUrlIndex]}",`);
    
    // Add explorerApiUrl if exists
    if (chain.explorerApiUrl) {
        lines.push(`${indent}    explorerApiUrl: "${chain.explorerApiUrl}",`);
    }
    
    // Add apiUrl if exists (deprecated)
    if (chain.apiUrl) {
        lines.push(`${indent}    apiUrl: "${chain.apiUrl}",`);
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
    for (const [addrKey, value] of Object.entries(chain.addresses)) {
        lines.push(`${indent}        ${addrKey}: "${value}",`);
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
    console.log('Fetching chainlist.org RPC data...');
    const chainlistData = await fetchJson(CHAINLIST_API_URL);
    
    console.log(`Found ${chainlistData.length} chains from chainlist.org`);
    
    console.log('Loading existing chains from config...');
    const existingChains = await loadExistingChains();
    const existingChainIds = Object.values(existingChains).map(c => c.chainId);
    console.log(`Found ${existingChainIds.length} existing chains in config`);
    
    // Build chainId -> chainlist data map
    const chainlistMap = new Map();
    for (const chain of chainlistData) {
        if (chain.chainId) {
            chainlistMap.set(chain.chainId, chain);
        }
    }
    
    // Merge data
    console.log('\nMerging RPC and explorer data...');
    const updatedChains = {};
    let mergedCount = 0;
    let totalNewRpcs = 0;
    let totalNewExplorers = 0;
    
    for (const [key, chain] of Object.entries(existingChains)) {
        const chainlistChain = chainlistMap.get(chain.chainId);
        
        if (chainlistChain) {
            const originalRpcCount = chain.rpcUrls.length;
            const originalExplorerCount = 1; // Just explorerUrl field
            
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
            // No chainlist data, keep original but add explorerUrls array
            updatedChains[key] = {
                ...chain,
                explorerUrls: [chain.explorerUrl],
                defaultExplorerUrlIndex: 0,
            };
        }
    }
    
    console.log(`\n✓ Merged data for ${mergedCount} chains`);
    console.log(`  Total new RPCs: ${totalNewRpcs}`);
    console.log(`  Total new explorers: ${totalNewExplorers}`);
    
    // Generate output file
    console.log('\nGenerating updated chains file...');
    const outputLines = [
        '// Centralized chain configuration for scripts',
        '// Updated with additional RPCs and explorers from chainlist.org',
        '// Each chain has a stable key usable as chainConfig[key].variable',
        '// rpcUrls is an array, with defaultRpcUrlIndex selecting the preferred one',
        '// explorerUrls is an array, with defaultExplorerUrlIndex selecting the preferred one',
        '',
        'export const chainConfig = {',
    ];
    
    for (const [key, chain] of Object.entries(updatedChains)) {
        outputLines.push(formatChainObject(key, chain));
    }
    
    outputLines.push('}');
    outputLines.push('');
    
    // Add helper functions from original file
    outputLines.push('export function getRpcUrl(chain) {');
    outputLines.push('    if (!chain) return null;');
    outputLines.push('    if (!chain.rpcUrls || chain.rpcUrls.length === 0) return null;');
    outputLines.push('    const index = chain.defaultRpcUrlIndex || 0;');
    outputLines.push('    return chain.rpcUrls[index] || chain.rpcUrls[0];');
    outputLines.push('}');
    outputLines.push('');
    outputLines.push('export function getExplorerUrl(chain) {');
    outputLines.push('    if (!chain) return null;');
    outputLines.push('    if (!chain.explorerUrls || chain.explorerUrls.length === 0) return chain.explorerUrl || null;');
    outputLines.push('    const index = chain.defaultExplorerUrlIndex || 0;');
    outputLines.push('    return chain.explorerUrls[index] || chain.explorerUrls[0];');
    outputLines.push('}');
    outputLines.push('');
    
    await fs.writeFile(OUTPUT_PATH, outputLines.join('\n'), 'utf-8');
    console.log(`\n✓ Updated chains saved to ${OUTPUT_PATH}`);
    console.log('\nReview the file and replace chains.mjs if everything looks good.');
}

main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
});
