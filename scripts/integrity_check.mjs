#!/usr/bin/env node

import { ethers } from 'ethers';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default contract addresses
const DEFAULT_ADDRESSES = {
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    entryPoint: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
    trustedForwarder: '0xB2b5841DBeF766d4b521221732F9B618fCf34A87',
    relayRouter: '0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222',
    create5: '0x7000000db505d50f077492Efa36a8968ff7493dD',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Load ABIs
const loadAbi = (name) => {
    const abiPath = path.join(__dirname, 'abis', `${name}.json`);
    return JSON.parse(fs.readFileSync(abiPath, 'utf8'));
};

const ABIS = {
    WETH: loadAbi('WETH'),
    ENTRY_POINT: loadAbi('ENTRY_POINT'),
    TRUSTED_FORWARDER: loadAbi('TRUSTED_FORWARDER'),
    RELAY_ROUTER: loadAbi('RELAY_ROUTER'),
    PERMIT2: loadAbi('PERMIT2'),
    MESSAGE_TRANSMITTER: loadAbi('MESSAGE_TRANSMITTER'),
    TOKEN_MESSENGER: loadAbi('TOKEN_MESSENGER'),
    CREATE5: loadAbi('CREATE5'),
    MULTICALL3: loadAbi('MULTICALL3'),
};

// Load chain config
const loadChainConfig = async () => {
    const configPath = path.join(__dirname, '..', 'chains.mjs');
    const configModule = await import(`file://${configPath}`);
    return configModule.chainConfig;
};

// Basic integrity checks
function checkBasicIntegrity(chainConfig) {
    console.log('\n=== Basic Integrity Checks ===');
    const issues = [];
    const keys = new Set();
    const chainIds = new Set();
    const lzIds = new Set();

    for (const [key, chain] of Object.entries(chainConfig)) {
        // Check duplicate keys
        if (keys.has(key)) {
            issues.push(`Duplicate key: ${key}`);
        }
        keys.add(key);

        // Check duplicate chainIds
        if (chainIds.has(chain.chainId)) {
            issues.push(`Duplicate chainId ${chain.chainId} for key: ${key}`);
        }
        chainIds.add(chain.chainId);

        // Check duplicate non-zero LayerZero IDs
        if (chain.lzSrcId && chain.lzSrcId !== 0) {
            if (lzIds.has(chain.lzSrcId)) {
                issues.push(`Duplicate LayerZero ID ${chain.lzSrcId} for key: ${key}`);
            }
            lzIds.add(chain.lzSrcId);
        }
    }

    if (issues.length === 0) {
        console.log('✓ No duplicate keys, chainIds, or LayerZero IDs found');
    } else {
        console.log('✗ Issues found:');
        issues.forEach(issue => console.log(`  - ${issue}`));
    }

    return issues;
}

// Test RPC connectivity
async function testRpc(rpcUrl, timeout = 10000) {
    try {
        const provider = new ethers.providers.JsonRpcProvider({ url: rpcUrl, timeout });
        const network = await provider.getNetwork();
        return { success: true, chainId: network.chainId };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Verify RPC URLs
async function verifyRpcs(chainConfig) {
    console.log('\n=== RPC Verification ===');
    const results = {};
    const corrections = {};

    for (const [key, chain] of Object.entries(chainConfig)) {
        console.log(`\nChecking ${chain.display} (${key})...`);
        const rpcResults = [];

        for (let i = 0; i < chain.rpcUrls.length; i++) {
            const rpcUrl = chain.rpcUrls[i];
            process.stdout.write(`  [${i}] ${rpcUrl.substring(0, 50)}... `);
            
            const result = await testRpc(rpcUrl);
            rpcResults.push({ index: i, url: rpcUrl, ...result });

            if (result.success) {
                if (result.chainId !== chain.chainId) {
                    console.log(`✗ CHAINID MISMATCH (expected ${chain.chainId}, got ${result.chainId})`);
                } else {
                    console.log('✓ OK');
                }
            } else {
                console.log(`✗ FAILED (${result.error?.substring(0, 60)})`);
            }
        }

        // Find first working RPC
        const workingRpc = rpcResults.find(r => r.success && r.chainId === chain.chainId);
        const anyWorkingRpc = rpcResults.find(r => r.success);

        if (workingRpc && workingRpc.index !== chain.defaultRpcUrlIndex) {
            console.log(`  ℹ Suggestion: Set defaultRpcUrlIndex to ${workingRpc.index}`);
            corrections[key] = { ...corrections[key], defaultRpcUrlIndex: workingRpc.index };
        }

        if (!workingRpc && anyWorkingRpc) {
            console.log(`  ⚠ Warning: No RPC with correct chainId. RPC at index ${anyWorkingRpc.index} returned chainId ${anyWorkingRpc.chainId}`);
            corrections[key] = { ...corrections[key], chainId: anyWorkingRpc.chainId };
        }

        if (!anyWorkingRpc) {
            console.log(`  ✗ ERROR: No working RPC URLs found for ${key}`);
        }

        results[key] = { rpcResults, workingRpc, anyWorkingRpc };
    }

    return { results, corrections };
}

// Verify contract interface
async function verifyContract(provider, address, abi, interfaceName) {
    if (!address || address === ZERO_ADDRESS) {
        return { exists: false, verified: false, reason: 'Zero address' };
    }

    // Convert to checksummed address if needed
    let checksummedAddress = address;
    try {
        checksummedAddress = ethers.utils.getAddress(address);
    } catch (e) {
        return { exists: false, verified: false, reason: `Invalid address format: ${e.message}` };
    }

    const needsChecksumFix = address !== checksummedAddress;

    try {
        const code = await provider.getCode(checksummedAddress);
        if (code === '0x') {
            return { exists: false, verified: false, reason: 'No code at address', checksummedAddress, needsChecksumFix };
        }

        const contract = new ethers.Contract(checksummedAddress, abi, provider);
        
        // Try to call a view function to verify interface
        // Different interfaces have different verifiable functions
        let verified = false;
        try {
            if (interfaceName === 'WETH') {
                await contract.symbol();
                verified = true;
            } else if (interfaceName === 'PERMIT2') {
                await contract.DOMAIN_SEPARATOR();
                verified = true;
            } else if (interfaceName === 'ENTRY_POINT') {
                await contract.getNonce(ZERO_ADDRESS, 0);
                verified = true;
            } else if (interfaceName === 'TRUSTED_FORWARDER') {
                await contract.getNonce(ZERO_ADDRESS);
                verified = true;
            } else if (interfaceName === 'MESSAGE_TRANSMITTER' || interfaceName === 'TOKEN_MESSENGER') {
                // These are proxy contracts - verify proxy interface
                await contract.implementation();
                verified = true;
            } else if (interfaceName === 'RELAY_ROUTER') {
                // RELAY_ROUTER doesn't have simple view functions to test
                // Just verify code exists (already checked above)
                verified = true;
            } else if (interfaceName === 'CREATE5') {
                // Verify CREATE5 by calling computeAddress
                await contract.computeAddress(ethers.utils.formatBytes32String('test'), ethers.utils.formatBytes32String('salt'));
                verified = true;
            } else if (interfaceName === 'MULTICALL3') {
                // Verify MULTICALL3 by calling getBlockNumber
                await contract.getBlockNumber();
                verified = true;
            }
        } catch (e) {
            return { exists: true, verified: false, reason: `Interface verification failed: ${e.message}`, checksummedAddress, needsChecksumFix };
        }

        return { exists: true, verified, reason: verified ? 'OK' : 'Unknown', checksummedAddress, needsChecksumFix };
    } catch (error) {
        return { exists: false, verified: false, reason: error.message, checksummedAddress, needsChecksumFix };
    }
}

// Verify all contracts for a chain
async function verifyContracts(chainConfig, rpcResults) {
    console.log('\n=== Contract Verification ===');
    const results = {};
    const corrections = {};

    for (const [key, chain] of Object.entries(chainConfig)) {
        // Skip if no working RPC
        const rpcInfo = rpcResults[key];
        if (!rpcInfo?.workingRpc && !rpcInfo?.anyWorkingRpc) {
            console.log(`\nSkipping ${chain.display} (no working RPC)`);
            continue;
        }

        const rpc = (rpcInfo.workingRpc || rpcInfo.anyWorkingRpc).url;
        const provider = new ethers.providers.JsonRpcProvider({ url: rpc, timeout: 10000 });

        console.log(`\nVerifying contracts for ${chain.display} (${key})...`);
        const chainResults = {};

        // Check each contract type
        const contractChecks = [
            { key: 'wrappedGasToken', abi: ABIS.WETH, name: 'WETH', default: null },
            { key: 'permit2', abi: ABIS.PERMIT2, name: 'PERMIT2', default: DEFAULT_ADDRESSES.permit2 },
            { key: 'entryPoint', abi: ABIS.ENTRY_POINT, name: 'ENTRY_POINT', default: DEFAULT_ADDRESSES.entryPoint },
            { key: 'trustedForwarder', abi: ABIS.TRUSTED_FORWARDER, name: 'TRUSTED_FORWARDER', default: DEFAULT_ADDRESSES.trustedForwarder },
            { key: 'relayRouter', abi: ABIS.RELAY_ROUTER, name: 'RELAY_ROUTER', default: DEFAULT_ADDRESSES.relayRouter },
            { key: 'messageTransmitter', abi: ABIS.MESSAGE_TRANSMITTER, name: 'MESSAGE_TRANSMITTER', default: DEFAULT_ADDRESSES.messageTransmitter },
            { key: 'tokenMessenger', abi: ABIS.TOKEN_MESSENGER, name: 'TOKEN_MESSENGER', default: DEFAULT_ADDRESSES.tokenMessenger },
            { key: 'create5', abi: ABIS.CREATE5, name: 'CREATE5', default: DEFAULT_ADDRESSES.create5 },
            { key: 'multicall3', abi: ABIS.MULTICALL3, name: 'MULTICALL3', default: DEFAULT_ADDRESSES.multicall3 },
        ];

        const checkedAddressKeys = new Set();
        const checksumIssues = [];

        for (const check of contractChecks) {
            const configAddress = chain.addresses?.[check.key];
            checkedAddressKeys.add(check.key);
            process.stdout.write(`  ${check.name.padEnd(20)} `);

            // First try configured address
            let result = await verifyContract(provider, configAddress, check.abi, check.name);
            let finalAddress = configAddress;
            let usedDefault = false;

            // Track checksum issues
            if (result.needsChecksumFix && result.checksummedAddress) {
                checksumIssues.push({ key: check.key, original: configAddress, checksummed: result.checksummedAddress });
            }

            // If configured address doesn't work, try default
            if (!result.verified && check.default) {
                if (configAddress === ZERO_ADDRESS) {
                    // Zero address configured - verify that default also doesn't exist
                    const defaultResult = await verifyContract(provider, check.default, check.abi, check.name);
                    if (defaultResult.verified) {
                        // Default exists! Suggest using it
                        result = defaultResult;
                        finalAddress = check.default;
                        usedDefault = true;
                    } else {
                        // Default also doesn't exist, zero is correct
                        result = { exists: false, verified: true, reason: 'Zero address verified (default not deployed)' };
                    }
                } else if (result.checksummedAddress) {
                    // Try with checksummed address
                    finalAddress = result.checksummedAddress;
                }
            }

            chainResults[check.key] = { ...result, address: finalAddress, configAddress, usedDefault };

            if (result.verified) {
                const explorerUrl = chain.explorerUrl && finalAddress !== ZERO_ADDRESS ? `${chain.explorerUrl}/address/${finalAddress}#code` : '';
                const checksumNote = result.needsChecksumFix ? ' (needs checksum fix)' : '';
                console.log(`✓ ${usedDefault ? '(using default) ' : ''}${finalAddress.substring(0, 10)}...${checksumNote}${explorerUrl ? ' ' + explorerUrl : ''}`);
                if (usedDefault) {
                    if (!corrections[key]) corrections[key] = { addresses: {} };
                    if (!corrections[key].addresses) corrections[key].addresses = {};
                    corrections[key].addresses[check.key] = finalAddress;
                }
            } else {
                console.log(`✗ ${result.reason}`);
            }
        }

        // Report checksum issues
        if (checksumIssues.length > 0) {
            console.log('\n  ⚠ Address checksum issues found:');
            for (const issue of checksumIssues) {
                console.log(`    ${issue.key}: ${issue.original} → ${issue.checksummed}`);
                if (!corrections[key]) corrections[key] = { addresses: {} };
                if (!corrections[key].addresses) corrections[key].addresses = {};
                corrections[key].addresses[issue.key] = issue.checksummed;
            }
        }

        // Check all other non-zero addresses for deployed bytecode
        if (chain.addresses) {
            const otherChecksumIssues = [];
            
            for (const [addrKey, addrValue] of Object.entries(chain.addresses)) {
                // Skip already checked addresses and zero addresses
                if (checkedAddressKeys.has(addrKey) || !addrValue || addrValue === ZERO_ADDRESS) {
                    continue;
                }

                process.stdout.write(`  ${addrKey.padEnd(20)} `);
                
                try {
                    // Convert to checksummed address
                    let checksummedAddr = addrValue;
                    let needsChecksumFix = false;
                    try {
                        checksummedAddr = ethers.utils.getAddress(addrValue);
                        needsChecksumFix = addrValue !== checksummedAddr;
                    } catch (e) {
                        console.log(`✗ Invalid address format`);
                        continue;
                    }

                    const code = await provider.getCode(checksummedAddr);
                    const hasCode = code !== '0x';
                    
                    if (needsChecksumFix) {
                        otherChecksumIssues.push({ key: addrKey, original: addrValue, checksummed: checksummedAddr });
                    }
                    
                    chainResults[addrKey] = { 
                        exists: hasCode, 
                        verified: hasCode, 
                        reason: hasCode ? 'Has code' : 'No code at address',
                        address: checksummedAddr,
                        configAddress: addrValue,
                        usedDefault: false,
                        needsChecksumFix
                    };

                    if (hasCode) {
                        const explorerUrl = chain.explorerUrl ? `${chain.explorerUrl}/address/${checksummedAddr}#code` : '';
                        const checksumNote = needsChecksumFix ? ' (needs checksum fix)' : '';
                        console.log(`✓ ${checksummedAddr.substring(0, 10)}...${checksumNote}${explorerUrl ? ' ' + explorerUrl : ''}`);
                    } else {
                        console.log(`✗ No code at address`);
                    }
                } catch (error) {
                    chainResults[addrKey] = { 
                        exists: false, 
                        verified: false, 
                        reason: error.message,
                        address: addrValue,
                        configAddress: addrValue,
                        usedDefault: false
                    };
                    console.log(`✗ Error: ${error.message}`);
                }
            }

            // Report other checksum issues
            if (otherChecksumIssues.length > 0) {
                console.log('\n  ⚠ Address checksum issues found:');
                for (const issue of otherChecksumIssues) {
                    console.log(`    ${issue.key}: ${issue.original} → ${issue.checksummed}`);
                    if (!corrections[key]) corrections[key] = { addresses: {} };
                    if (!corrections[key].addresses) corrections[key].addresses = {};
                    corrections[key].addresses[issue.key] = issue.checksummed;
                }
            }
        }

        results[key] = chainResults;
    }

    return { results, corrections };
}

// Required addresses that every chain should have
const REQUIRED_ADDRESSES = [
    'gasToken',
    'wrappedGasToken',
    'usdc',
    'usdt',
    'permit2',
    'entryPoint',
    'trustedForwarder',
    'relayRouter',
    'messageTransmitter',
    'tokenMessenger',
    'create5',
    'multicall3',
];

// Generate corrected config
function generateCorrectedConfig(chainConfig, allCorrections) {
    const corrected = JSON.parse(JSON.stringify(chainConfig)); // Deep clone
    const changesSummary = {};

    for (const [key, chain] of Object.entries(corrected)) {
        const chainChanges = [];

        // Apply corrections from checks
        const corrections = allCorrections[key];
        if (corrections) {
            if (corrections.defaultRpcUrlIndex !== undefined) {
                corrected[key].defaultRpcUrlIndex = corrections.defaultRpcUrlIndex;
                chainChanges.push(`Updated defaultRpcUrlIndex to ${corrections.defaultRpcUrlIndex}`);
            }

            if (corrections.chainId !== undefined) {
                corrected[key].chainId = corrections.chainId;
                chainChanges.push(`Updated chainId to ${corrections.chainId}`);
            }

            if (corrections.addresses) {
                if (!corrected[key].addresses) corrected[key].addresses = {};
                for (const [addrKey, addrValue] of Object.entries(corrections.addresses)) {
                    corrected[key].addresses[addrKey] = addrValue;
                    chainChanges.push(`Updated address ${addrKey} to ${addrValue}`);
                }
            }
        }

        // Ensure all required addresses are present
        if (!corrected[key].addresses) corrected[key].addresses = {};
        for (const addrKey of REQUIRED_ADDRESSES) {
            if (!corrected[key].addresses[addrKey]) {
                corrected[key].addresses[addrKey] = ZERO_ADDRESS;
                chainChanges.push(`Added missing address ${addrKey} as zero address`);
            }
        }

        if (chainChanges.length > 0) {
            changesSummary[key] = chainChanges;
        }
    }

    const hasChanges = Object.keys(changesSummary).length > 0;
    return { corrected, hasChanges, changesSummary };
}

// Format a chain object as JavaScript code
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

    // Add explorerUrls if present
    if (chain.explorerUrls && Array.isArray(chain.explorerUrls)) {
        lines.push(`${indent}    explorerUrls: [`);
        for (const url of chain.explorerUrls) {
            lines.push(`${indent}        "${url}",`);
        }
        lines.push(`${indent}    ],`);
        lines.push(`${indent}    defaultExplorerUrlIndex: ${chain.defaultExplorerUrlIndex || 0},`);
    }

    // Add explorerUrl
    lines.push(`${indent}    explorerUrl: "${chain.explorerUrl}",`);

    // Add explorerApiUrl/apiUrl if exists
    if (chain.explorerApiUrl) {
        lines.push(`${indent}    explorerApiUrl: "${chain.explorerApiUrl}",`);
    }
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

// Save corrected config to file
function saveCorrectedConfig(correctedConfig) {
    const outputPath = path.join(__dirname, '..', 'chains-corrected.mjs');
    
    const outputLines = [
        '// Auto-generated corrected chain configuration',
        `// Generated on ${new Date().toISOString()}`,
        '// Centralized chain configuration for scripts',
        '// Each chain has a stable key usable as chainConfig[key].variable',
        '// rpcUrls is an array, with defaultRpcUrlIndex selecting the preferred one',
        '',
        'export const chainConfig = {',
    ];

    for (const [key, chain] of Object.entries(correctedConfig)) {
        outputLines.push(formatChainObject(key, chain));
    }

    outputLines.push('}');
    outputLines.push('');

    // Add helper functions
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

    fs.writeFileSync(outputPath, outputLines.join('\n'), 'utf8');
    console.log(`\n✓ Corrected configuration saved to: ${outputPath}`);
}

// Commands
async function cmdCheck() {
    const chainConfig = await loadChainConfig();
    checkBasicIntegrity(chainConfig);
    console.log('\n✓ Basic integrity check complete');
}

async function cmdVerifyRpcs() {
    const chainConfig = await loadChainConfig();
    const { results, corrections } = await verifyRpcs(chainConfig);
    
    if (Object.keys(corrections).length > 0) {
        console.log('\n=== Suggested Corrections ===');
        console.log(JSON.stringify(corrections, null, 2));
    }
}

async function cmdVerifyContracts() {
    const chainConfig = await loadChainConfig();
    const { results: rpcResults } = await verifyRpcs(chainConfig);
    const { results, corrections } = await verifyContracts(chainConfig, rpcResults);
    
    if (Object.keys(corrections).length > 0) {
        console.log('\n=== Suggested Corrections ===');
        console.log(JSON.stringify(corrections, null, 2));
    }
}

async function cmdFix() {
    const chainConfig = await loadChainConfig();
    
    // Run all checks
    checkBasicIntegrity(chainConfig);
    const { corrections: rpcCorrections, results: rpcResults } = await verifyRpcs(chainConfig);
    const { corrections: contractCorrections } = await verifyContracts(chainConfig, rpcResults);
    
    // Merge corrections
    const allCorrections = {};
    for (const key of new Set([...Object.keys(rpcCorrections), ...Object.keys(contractCorrections)])) {
        allCorrections[key] = {
            ...rpcCorrections[key],
            ...contractCorrections[key],
            addresses: {
                ...rpcCorrections[key]?.addresses,
                ...contractCorrections[key]?.addresses,
            },
        };
    }
    
    const { corrected, hasChanges, changesSummary } = generateCorrectedConfig(chainConfig, allCorrections);
    
    if (hasChanges) {
        // Print summary of changes
        console.log('\n=== Summary of Fixes ===');
        let totalChanges = 0;
        for (const [chainKey, changes] of Object.entries(changesSummary)) {
            const chain = chainConfig[chainKey];
            const displayName = chain?.display || chain?.name || chainKey;
            console.log(`\n${displayName} (${chainKey}):`);
            for (const change of changes) {
                console.log(`  • ${change}`);
                totalChanges++;
            }
        }
        console.log(`\n✓ Total: ${totalChanges} changes across ${Object.keys(changesSummary).length} chains`);
        
        saveCorrectedConfig(corrected);
        console.log('\n✓ Corrections applied. Review chains-corrected.mjs before using.');
    } else {
        console.log('\n✓ No corrections needed. Configuration is valid.');
    }
}

// Main CLI
async function main() {
    const argv = yargs(hideBin(process.argv))
        .scriptName('integrity_check')
        .usage('Usage: $0 <command> [options]')
        .command(
            'check',
            'Run basic integrity checks (duplicates)',
            {},
            async () => await cmdCheck()
        )
        .command(
            'verify-rpcs',
            'Verify RPC connectivity and chainIds',
            {},
            async () => await cmdVerifyRpcs()
        )
        .command(
            'verify-contracts',
            'Verify contract interfaces on-chain',
            {},
            async () => await cmdVerifyContracts()
        )
        .command(
            'fix',
            'Run all checks and generate corrected config file',
            {},
            async () => await cmdFix()
        )
        .demandCommand(1, 'You must specify a command: check, verify-rpcs, verify-contracts, or fix')
        .alias('h', 'help')
        .help()
        .wrap(Math.min(120, process.stdout.columns || 100))
        .argv;
}

main().catch((err) => {
    console.error('Error:', err?.message || err);
    process.exit(1);
});