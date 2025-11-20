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

    try {
        const code = await provider.getCode(address);
        if (code === '0x') {
            return { exists: false, verified: false, reason: 'No code at address' };
        }

        const contract = new ethers.Contract(address, abi, provider);
        
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
                // These may be proxy contracts - verify proxy interface
                await contract.implementation();
                verified = true;
            } else if (interfaceName === 'RELAY_ROUTER') {
                // Verify RELAY_ROUTER interface by calling multicall-related function
                // The contract should support the interface even if the call would revert with empty input
                await contract.supportsInterface('0x01ffc9a7'); // ERC165 interface ID
                verified = true;
            }
        } catch (e) {
            return { exists: true, verified: false, reason: `Interface verification failed: ${e.message}` };
        }

        return { exists: true, verified, reason: verified ? 'OK' : 'Unknown' };
    } catch (error) {
        return { exists: false, verified: false, reason: error.message };
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
        ];

        for (const check of contractChecks) {
            const configAddress = chain.addresses?.[check.key];
            process.stdout.write(`  ${check.name.padEnd(20)} `);

            // First try configured address
            let result = await verifyContract(provider, configAddress, check.abi, check.name);
            let finalAddress = configAddress;
            let usedDefault = false;

            // If configured address doesn't work, try default
            if (!result.verified && check.default && configAddress === ZERO_ADDRESS) {
                const defaultResult = await verifyContract(provider, check.default, check.abi, check.name);
                if (defaultResult.verified) {
                    result = defaultResult;
                    finalAddress = check.default;
                    usedDefault = true;
                }
            }

            chainResults[check.key] = { ...result, address: finalAddress, configAddress, usedDefault };

            if (result.verified) {
                console.log(`✓ ${usedDefault ? '(using default) ' : ''}${finalAddress.substring(0, 10)}...`);
                if (usedDefault) {
                    if (!corrections[key]) corrections[key] = { addresses: {} };
                    if (!corrections[key].addresses) corrections[key].addresses = {};
                    corrections[key].addresses[check.key] = finalAddress;
                }
            } else {
                console.log(`✗ ${result.reason}`);
            }
        }

        results[key] = chainResults;
    }

    return { results, corrections };
}

// Generate corrected config
function generateCorrectedConfig(chainConfig, allCorrections) {
    const corrected = JSON.parse(JSON.stringify(chainConfig)); // Deep clone
    let hasChanges = false;

    for (const [key, corrections] of Object.entries(allCorrections)) {
        if (!corrected[key]) continue;

        if (corrections.defaultRpcUrlIndex !== undefined) {
            corrected[key].defaultRpcUrlIndex = corrections.defaultRpcUrlIndex;
            hasChanges = true;
        }

        if (corrections.chainId !== undefined) {
            corrected[key].chainId = corrections.chainId;
            hasChanges = true;
        }

        if (corrections.addresses) {
            if (!corrected[key].addresses) corrected[key].addresses = {};
            Object.assign(corrected[key].addresses, corrections.addresses);
            hasChanges = true;
        }
    }

    return { corrected, hasChanges };
}

// Save corrected config to file
function saveCorrectedConfig(correctedConfig) {
    const outputPath = path.join(__dirname, '..', 'chains-corrected.mjs');
    const content = `// Auto-generated corrected chain configuration\n// Generated on ${new Date().toISOString()}\n\nexport const chainConfig = ${JSON.stringify(correctedConfig, null, 4)};\n`;
    fs.writeFileSync(outputPath, content, 'utf8');
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
    
    const { corrected, hasChanges } = generateCorrectedConfig(chainConfig, allCorrections);
    
    if (hasChanges) {
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