#!/usr/bin/env node

import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load chain config
const loadChainConfig = async () => {
    const configPath = path.join(__dirname, '..', 'chains.mjs');
    const configModule = await import(`file://${configPath}`);
    return configModule.chainConfig;
};

/**
 * Fetch list of chains supported by Etherscan
 */
async function fetchEtherscanSupportedChains() {
    console.log('Fetching Etherscan supported chains...');
    
    try {
        const response = await fetch('https://api.etherscan.io/v2/chainlist');
        const data = await response.json();

        if (data.result && Array.isArray(data.result)) {
            // Return a Set of chainIds for quick lookup
            const chainIds = new Set(data.result.map(chain => parseInt(chain.chainid)));
            console.log(`✓ Fetched ${chainIds.size} Etherscan-supported chains\n`);
            return chainIds;
        }
        return new Set();
    } catch (error) {
        console.error(`✗ Error fetching Etherscan supported chains: ${error.message}`);
        return new Set();
    }
}

/**
 * Fetch CoinGecko asset platforms
 */
async function fetchCoinGeckoPlatforms() {
    const apiKey = process.env.COINGECKO_API_KEY || process.env.CG_API_KEY;
    const baseUrl = apiKey 
        ? 'https://pro-api.coingecko.com/api/v3'
        : 'https://api.coingecko.com/api/v3';
    
    const headers = apiKey ? { 'x-cg-pro-api-key': apiKey } : {};
    
    console.log(`Fetching CoinGecko platforms from ${baseUrl}...`);
    if (apiKey) {
        console.log('Using Pro API with API key');
    } else {
        console.log('Using Free API (no API key found in COINGECKO_API_KEY or CG_API_KEY)');
    }

    try {
        const response = await fetch(`${baseUrl}/asset_platforms`, { headers });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`✓ Fetched ${data.length} platforms from CoinGecko\n`);
        
        return data;
    } catch (error) {
        console.error(`✗ Error fetching CoinGecko platforms: ${error.message}`);
        throw error;
    }
}

/**
 * Match CoinGecko platforms to chains
 */
function matchPlatformsToChains(chainConfig, platforms) {
    console.log('=== Matching Platforms to Chains ===\n');
    
    const results = {};
    const matchedPlatforms = new Set();
    const unmatchedChains = [];
    
    // Create lookup map by chain_identifier
    const platformsByChainId = new Map();
    for (const platform of platforms) {
        if (platform.chain_identifier !== null && platform.chain_identifier !== undefined) {
            platformsByChainId.set(platform.chain_identifier, platform);
        }
    }
    
    // Match chains to platforms
    for (const [key, chain] of Object.entries(chainConfig)) {
        const platform = platformsByChainId.get(chain.chainId);
        
        if (platform) {
            results[key] = {
                cgPlatformId: platform.id,
                cgGasAssetId: platform.native_coin_id,
                platformName: platform.name,
                platformShortname: platform.shortname
            };
            matchedPlatforms.add(platform.id);
            
            console.log(`✓ ${chain.display?.padEnd(30)} → ${platform.id.padEnd(20)} (gas: ${platform.native_coin_id})`);
        } else {
            unmatchedChains.push({ key, chain });
            console.log(`○ ${chain.display?.padEnd(30)} → No CoinGecko platform found`);
        }
    }
    
    console.log(`\n=== Summary ===`);
    console.log(`Matched: ${Object.keys(results).length}/${Object.keys(chainConfig).length} chains`);
    console.log(`Unmatched: ${unmatchedChains.length} chains`);
    
    if (unmatchedChains.length > 0) {
        console.log('\nUnmatched chains:');
        unmatchedChains.forEach(({ key, chain }) => {
            console.log(`  - ${key} (${chain.display}, chainId: ${chain.chainId})`);
        });
    }
    
    return results;
}

/**
 * Format a chain object as JavaScript code with CoinGecko fields
 */
function formatChainObject(key, chain, indent = '    ') {
    const lines = [
        `${indent}${key}: {`,
        `${indent}    key: "${chain.key}",`,
    ];

    // Add display/name field
    if (chain.display !== undefined) {
        lines.push(`${indent}    display: "${chain.display}",`);
    }
    if (chain.name !== undefined) {
        lines.push(`${indent}    name: "${chain.name}",`);
    }

    lines.push(`${indent}    currency: "${chain.currency}",`);
    lines.push(`${indent}    vmType: "${chain.vmType || 'EVM'}",`);
    lines.push(`${indent}    chainId: ${chain.chainId},`);
    lines.push(`${indent}    lzSrcId: ${chain.lzSrcId},`);
    
    // Add CoinGecko fields (always present, either as string or null)
    if (chain.cgPlatformId !== undefined) {
        const value = chain.cgPlatformId === null ? 'null' : `"${chain.cgPlatformId}"`;
        lines.push(`${indent}    cgPlatformId: ${value},`);
    }
    if (chain.cgGasAssetId !== undefined) {
        const value = chain.cgGasAssetId === null ? 'null' : `"${chain.cgGasAssetId}"`;
        lines.push(`${indent}    cgGasAssetId: ${value},`);
    }

    // Add explorerUrls
    if (chain.explorerUrls && Array.isArray(chain.explorerUrls)) {
        lines.push(`${indent}    explorerUrls: [`);
        for (const url of chain.explorerUrls) {
            lines.push(`${indent}        "${url}",`);
        }
        lines.push(`${indent}    ],`);
        lines.push(`${indent}    defaultExplorerUrlIndex: ${chain.defaultExplorerUrlIndex || 0},`);
    }

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
    
    // Order: token addresses first, then contract addresses
    const tokenAddresses = ['gasToken', 'wrappedGasToken', 'usdc', 'usdt'];
    const contractAddresses = ['permit2', 'entryPoint', 'trustedForwarder', 'relayRouter', 'messageTransmitter', 'tokenMessenger', 'create5', 'multicall3'];
    const otherAddresses = Object.keys(chain.addresses || {}).filter(
        k => ![...tokenAddresses, ...contractAddresses].includes(k)
    );

    // Add token addresses
    for (const addrKey of tokenAddresses) {
        if (chain.addresses && chain.addresses[addrKey] !== undefined) {
            lines.push(`${indent}        ${addrKey}: "${chain.addresses[addrKey]}",`);
        }
    }

    // Add other addresses (like stables, etc)
    for (const addrKey of otherAddresses) {
        lines.push(`${indent}        ${addrKey}: "${chain.addresses[addrKey]}",`);
    }

    // Add contract addresses
    for (const addrKey of contractAddresses) {
        if (chain.addresses && chain.addresses[addrKey] !== undefined) {
            lines.push(`${indent}        ${addrKey}: "${chain.addresses[addrKey]}",`);
        }
    }

    lines.push(`${indent}    },`);
    lines.push(`${indent}},`);
    lines.push('');

    return lines.join('\n');
}

/**
 * Save extended config to file
 */
function saveExtendedConfig(extendedConfig, outputFileName = 'chains-with-coingecko.mjs') {
    const outputPath = path.join(__dirname, '..', outputFileName);
    
    const outputLines = [
        '// Auto-generated chain configuration with CoinGecko IDs',
        `// Generated on ${new Date().toISOString()}`,
        '// Centralized chain configuration for scripts',
        '// Each chain has a stable key usable as chainConfig[key].variable',
        '// rpcUrls is an array, with defaultRpcUrlIndex selecting the preferred one',
        '',
        '',
        'export const chainConfig = {',
    ];

    for (const [key, chain] of Object.entries(extendedConfig)) {
        outputLines.push(formatChainObject(key, chain));
    }

    outputLines.push('};');
    outputLines.push('');

    // Add helper functions
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

    fs.writeFileSync(outputPath, outputLines.join('\n'), 'utf8');
    console.log(`\n✓ Extended configuration saved to: ${outputFileName}`);
    console.log(`  Path: ${outputPath}`);
    
    return outputPath;
}

/**
 * Save mapping as JSON for reference
 */
function saveMappingJson(matches) {
    const outputPath = path.join(__dirname, '..', 'coingecko-mapping.json');
    fs.writeFileSync(outputPath, JSON.stringify(matches, null, 2), 'utf8');
    console.log(`✓ Mapping saved to: coingecko-mapping.json`);
}

/**
 * Main function
 */
async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('output', {
            alias: 'o',
            description: 'Output filename (default: chains-with-coingecko.mjs)',
            type: 'string',
            default: 'chains-with-coingecko.mjs'
        })
        .option('save-mapping', {
            description: 'Save mapping as JSON file',
            type: 'boolean',
            default: true
        })
        .help()
        .alias('help', 'h')
        .argv;

    console.log('='.repeat(80));
    console.log('CHAIN CONFIGURATION ENHANCER');
    console.log('Fetches CoinGecko IDs and updates Etherscan API URLs');
    console.log('='.repeat(80));
    console.log('');

    try {
        // Load chain configuration
        const chainConfig = await loadChainConfig();
        console.log(`Loaded ${Object.keys(chainConfig).length} chains from configuration\n`);

        // Fetch Etherscan supported chains
        const etherscanChains = await fetchEtherscanSupportedChains();

        // Fetch CoinGecko platforms
        const platforms = await fetchCoinGeckoPlatforms();

        // Match platforms to chains
        const matches = matchPlatformsToChains(chainConfig, platforms);

        // Create extended config
        const extendedConfig = JSON.parse(JSON.stringify(chainConfig)); // Deep clone
        
        // Add CoinGecko fields and update Etherscan API URLs
        console.log('\n=== Updating Chain Configuration ===\n');
        let etherscanUpdated = 0;
        
        for (const [key, chain] of Object.entries(extendedConfig)) {
            // Add CoinGecko fields
            if (matches[key]) {
                // Matched chain - add actual values
                extendedConfig[key].cgPlatformId = matches[key].cgPlatformId;
                extendedConfig[key].cgGasAssetId = matches[key].cgGasAssetId;
            } else {
                // Unmatched chain - add null values
                extendedConfig[key].cgPlatformId = null;
                extendedConfig[key].cgGasAssetId = null;
            }
            
            // Update explorerApiUrl for Etherscan-supported chains to use v2 API
            // If the chain is in the Etherscan-supported list and has an explorer API configured,
            // update it to use the v2 unified endpoint
            if (etherscanChains.has(chain.chainId) && chain.explorerApiUrl && !chain.explorerApiUrl.includes('/v2/')) {
                extendedConfig[key].explorerApiUrl = 'https://api.etherscan.io/v2/api';
                console.log(`✓ ${chain.display?.padEnd(30)} → Updated to Etherscan v2 API (chainId: ${chain.chainId})`);
                etherscanUpdated++;
            }
        }
        
        console.log(`\nUpdated ${etherscanUpdated} chains to use Etherscan v2 API`);

        // Save extended config
        console.log('\n=== Saving Output ===\n');
        saveExtendedConfig(extendedConfig, argv.output);

        // Save mapping JSON if requested
        if (argv.saveMapping) {
            saveMappingJson(matches);
        }

        console.log('\n' + '='.repeat(80));
        console.log('✓ Complete!');
        console.log('='.repeat(80));
    } catch (error) {
        console.error('\n✗ Error:', error.message);
        process.exit(1);
    }
}

// Run main function
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
