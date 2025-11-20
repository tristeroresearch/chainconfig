#!/usr/bin/env node
import https from 'https';
import http from 'http';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GASZIP_API_URL = 'https://backend.gas.zip/v2/chains';
const CHAINS_PATH = join(__dirname, '..', 'chains.mjs');
const OUTPUT_PATH_EVM = join(__dirname, '..', 'gz-chains-evm.mjs');
const OUTPUT_PATH_NON_EVM = join(__dirname, '..', 'gz-chains-non-evm.mjs');
const OUTPUT_PATH_ERROR = join(__dirname, '..', 'gz-chains-error.mjs');

// Default contract addresses (can be overridden per chain)
const DEFAULT_ADDRESSES = {
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    entryPoint: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
    trustedForwarder: '0xB2b5841DBeF766d4b521221732F9B618fCf34A87',
    relayRouter: '0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222',
    messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
};

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
 * Makes a JSON-RPC call to a given RPC URL
 */
function rpcCall(rpcUrl, method, params = []) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(rpcUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        
        const postData = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params,
        });
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 10000, // 10 second timeout
        };
        
        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        const msg = json.error.message || 'Unknown RPC error';
                        const code = json.error.code;
                        reject(new Error(`RPC error ${code}: ${msg}`));
                    } else {
                        resolve(json.result);
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse RPC response: ${e.message}`));
                }
            });
        });
        
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('RPC request timeout'));
        });
        
        req.write(postData);
        req.end();
    });
}

/**
 * Checks if an RPC URL is EVM-compatible by calling eth_chainId and eth_getBlockByNumber
 * Returns: 'EVM', 'Non-EVM', or 'CHECK_ERROR'
 */
async function checkEvmCompatibility(rpcUrl) {
    try {
        // 1) eth_chainId must exist and return a hex string
        const chainId = await rpcCall(rpcUrl, 'eth_chainId');
        if (typeof chainId !== 'string' || !chainId.startsWith('0x')) {
            // Method exists but returned unexpected format = Non-EVM
            return 'Non-EVM';
        }

        // 2) eth_getBlockByNumber("latest", false) should return an Ethereum-like block
        const block = await rpcCall(rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
        if (!block || typeof block !== 'object') {
            // Method exists but returned unexpected format = Non-EVM
            return 'Non-EVM';
        }

        const looksLikeEvmBlock =
            typeof block.number === 'string' &&
            typeof block.hash === 'string' &&
            typeof block.parentHash === 'string' &&
            typeof block.stateRoot === 'string' &&
            Array.isArray(block.transactions);

        return looksLikeEvmBlock ? 'EVM' : 'Non-EVM';
    } catch (e) {
        const errMsg = e.message || '';
        
        // If method is explicitly not found (RPC-32601), it's confirmed Non-EVM
        if (errMsg.includes('-32601') || errMsg.includes('Method not found')) {
            return 'Non-EVM';
        }
        
        // All other errors (timeout, network, etc.) are check errors
        // This includes: timeout, connection refused, DNS errors, rate limiting, etc.
        return 'CHECK_ERROR';
    }
}

/**
 * Generates a key from a chain name
 */
function generateKey(name) {
    return name
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

/**
 * Attempts to derive an API URL from an explorer URL
 */
function deriveApiUrl(explorerUrl) {
    if (!explorerUrl) return '';
    
    // Common patterns
    const patterns = [
        { match: /https:\/\/etherscan\.io/, replace: 'https://api.etherscan.io/api' },
        { match: /https:\/\/(.*?)scan\.io/, replace: (m, chain) => `https://api.${chain}scan.io/api` },
        { match: /https:\/\/(.+?)\.etherscan\.io/, replace: (m, chain) => `https://api-${chain}.etherscan.io/api` },
        { match: /https:\/\/explorer\.(.+?)\.io/, replace: (m, chain) => `https://api.explorer.${chain}.io/api` },
        { match: /https:\/\/blockscout\./, replace: (m) => `${explorerUrl.replace(/\/$/, '')}/api` },
    ];

    for (const { match, replace } of patterns) {
        if (match.test(explorerUrl)) {
            return typeof replace === 'function' 
                ? explorerUrl.replace(match, replace)
                : replace;
        }
    }

    // Default: append /api
    return `${explorerUrl.replace(/\/$/, '')}/api`;
}

/**
 * Converts a gas.zip chain to local config format
 */
async function convertGasZipChain(gzChain) {
    const key = generateKey(gzChain.name);
    const explorerUrl = gzChain.explorer || '';
    const rpcUrls = gzChain.rpcs || [];
    
    // Check EVM compatibility using the first RPC URL
    let vmType = 'CHECK_ERROR';
    if (rpcUrls.length > 0) {
        vmType = await checkEvmCompatibility(rpcUrls[0]);
    }
    
    return {
        key,
        name: gzChain.name,
        vmType,
        chainId: gzChain.chain,
        lzSrcId: 0,
        currency: gzChain.symbol || 'UNKNOWN',
        explorerUrl,
        apiUrl: deriveApiUrl(explorerUrl),
        rpcUrls,
        defaultRpcUrlIndex: 0,
        addresses: { ...DEFAULT_ADDRESSES },
    };
}

/**
 * Loads existing chains from chains.mjs
 */
async function loadExistingChains() {
    try {
        const content = await fs.readFile(CHAINS_PATH, 'utf-8');
        // Extract chainConfig object - this is a simple approach
        // We'll look for chainId values to build a Set
        const chainIdMatches = content.matchAll(/chainId:\s*(\d+)/g);
        const existingChainIds = new Set();
        for (const match of chainIdMatches) {
            existingChainIds.add(parseInt(match[1], 10));
        }
        return existingChainIds;
    } catch (e) {
        console.error(`Warning: Could not load existing chains: ${e.message}`);
        return new Set();
    }
}

/**
 * Formats a chain object as JavaScript code (as object property)
 */
function formatChainObject(chain) {
    const indent = '    ';
    const lines = [
        `${indent}${chain.key}: {`,
        `${indent}    key: "${chain.key}",`,
        `${indent}    name: "${chain.name}",`,
        `${indent}    vmType: "${chain.vmType}",`,
        `${indent}    chainId: ${chain.chainId},`,
        `${indent}    lzSrcId: ${chain.lzSrcId},`,
        `${indent}    currency: "${chain.currency}",`,
        `${indent}    explorerUrl: "${chain.explorerUrl}",`,
        `${indent}    apiUrl: "${chain.apiUrl}",`,
        `${indent}    rpcUrls: [`,
    ];
    
    for (const rpc of chain.rpcUrls) {
        lines.push(`${indent}        "${rpc}",`);
    }
    
    lines.push(`${indent}    ],`);
    lines.push(`${indent}    defaultRpcUrlIndex: ${chain.defaultRpcUrlIndex},`);
    lines.push(`${indent}    addresses: {`);
    
    for (const [key, value] of Object.entries(chain.addresses)) {
        lines.push(`${indent}        ${key}: "${value}",`);
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
    console.log('Fetching gas.zip chain definitions...');
    const data = await fetchJson(GASZIP_API_URL);
    
    if (!data.chains || !Array.isArray(data.chains)) {
        throw new Error('Invalid response format from gas.zip API');
    }
    
    console.log(`Found ${data.chains.length} chains from gas.zip`);
    
    console.log('Loading existing chains from config...');
    const existingChainIds = await loadExistingChains();
    console.log(`Found ${existingChainIds.size} existing chains in config`);
    
    // Convert and filter chains (only mainnet chains not already in config)
    console.log('\nChecking EVM compatibility for new chains...');
    const newChains = [];
    for (const gzChain of data.chains) {
        if (gzChain.mainnet === true && !existingChainIds.has(gzChain.chain)) {
            process.stdout.write(`  Checking ${gzChain.name}... `);
            const chain = await convertGasZipChain(gzChain);
            
            // Color code the output
            const vmTypeDisplay = 
                chain.vmType === 'EVM' ? '✓ EVM' :
                chain.vmType === 'Non-EVM' ? '✗ Non-EVM' :
                '⚠ CHECK_ERROR';
            console.log(vmTypeDisplay);
            
            newChains.push(chain);
        }
    }
    
    // Summary stats
    const evmCount = newChains.filter(c => c.vmType === 'EVM').length;
    const nonEvmCount = newChains.filter(c => c.vmType === 'Non-EVM').length;
    const errorCount = newChains.filter(c => c.vmType === 'CHECK_ERROR').length;
    
    console.log(`\nFound ${newChains.length} new chains not in your config:`);
    console.log(`  ✓ EVM: ${evmCount}`);
    console.log(`  ✗ Non-EVM: ${nonEvmCount}`);
    console.log(`  ⚠ CHECK_ERROR: ${errorCount}`);
    
    if (errorCount > 0) {
        console.log('\nChains with CHECK_ERROR (manual verification recommended):');
        for (const chain of newChains.filter(c => c.vmType === 'CHECK_ERROR')) {
            console.log(`  - ${chain.name} (chainId: ${chain.chainId})`);
        }
    }
    
    // Split chains by type
    const evmChains = newChains.filter(c => c.vmType === 'EVM');
    const nonEvmChains = newChains.filter(c => c.vmType === 'Non-EVM');
    const errorChains = newChains.filter(c => c.vmType === 'CHECK_ERROR');
    
    // Generate EVM chains file
    if (evmChains.length > 0) {
        const evmLines = [
            '// Auto-generated from gas.zip chain definitions',
            '// This file contains EVM-compatible chains supported by gas.zip that are not in your main chains.mjs',
            '// These chains have been verified to respond correctly to eth_chainId and eth_getBlockByNumber',
            '// You can selectively copy chains from here to your main config',
            '',
            'export const gaszipEvmChains = {',
        ];
        
        for (const chain of evmChains) {
            evmLines.push(formatChainObject(chain));
        }
        
        evmLines.push('};');
        evmLines.push('');
        
        await fs.writeFile(OUTPUT_PATH_EVM, evmLines.join('\n'), 'utf-8');
        console.log(`\n✓ Saved ${evmChains.length} EVM chains to ${OUTPUT_PATH_EVM}`);
    }
    
    // Generate Non-EVM chains file
    if (nonEvmChains.length > 0) {
        const nonEvmLines = [
            '// Auto-generated from gas.zip chain definitions',
            '// This file contains Non-EVM chains supported by gas.zip that are not in your main chains.mjs',
            '// These chains have been confirmed to NOT support standard Ethereum JSON-RPC methods',
            '// Review carefully before adding to your config',
            '',
            'export const gaszipNonEvmChains = {',
        ];
        
        for (const chain of nonEvmChains) {
            nonEvmLines.push(formatChainObject(chain));
        }
        
        nonEvmLines.push('};');
        nonEvmLines.push('');
        
        await fs.writeFile(OUTPUT_PATH_NON_EVM, nonEvmLines.join('\n'), 'utf-8');
        console.log(`✓ Saved ${nonEvmChains.length} Non-EVM chains to ${OUTPUT_PATH_NON_EVM}`);
    }
    
    // Generate error chains file
    if (errorChains.length > 0) {
        const errorLines = [
            '// Auto-generated from gas.zip chain definitions',
            '// This file contains chains that could not be verified due to RPC errors',
            '// Possible reasons: timeout, unreachable endpoint, rate limiting, or temporary downtime',
            '//',
            '// ⚠ MANUAL VERIFICATION REQUIRED ⚠',
            '// Check each chain\'s block explorer to determine if it\'s EVM-compatible',
            '// Then update vmType to "EVM" or "Non-EVM" before adding to your main config',
            '',
            'export const gaszipErrorChains = {',
        ];
        
        for (const chain of errorChains) {
            errorLines.push(formatChainObject(chain));
        }
        
        errorLines.push('};');
        errorLines.push('');
        
        await fs.writeFile(OUTPUT_PATH_ERROR, errorLines.join('\n'), 'utf-8');
        console.log(`✓ Saved ${errorChains.length} chains with errors to ${OUTPUT_PATH_ERROR}`);
    }
    
    console.log('\n✓ All files generated successfully!');
}

main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
});
