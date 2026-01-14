#!/usr/bin/env node
import 'dotenv/config';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { chainConfig, configuredChains, getChainsByKeys } from '../chains.mjs';

const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (await import('node-fetch')).default;

const DEFAULT_TIMEOUT_MS = 10000;

const argv = yargs(hideBin(process.argv))
  .scriptName('check_eth_callmany')
  .usage('Usage:\n  $0 --rpcs <url...>\n  $0 --chains ethereum,polygon\n  $0 --all-chains')
  .option('rpcs', {
    type: 'string',
    array: true,
    describe: 'Manual RPC URLs to probe (space/comma separated).',
  })
  .option('chains', {
    type: 'string',
    describe: 'Comma/space separated chain keys from chainconfig to probe (uses their rpcUrls).',
  })
  .option('all-chains', {
    type: 'boolean',
    default: false,
    describe: 'Probe every chain defined in chainconfig/chains.mjs.',
  })
  .option('timeout', {
    type: 'number',
    default: DEFAULT_TIMEOUT_MS,
    describe: 'Per-RPC request timeout in milliseconds (default: 10000)',
  })
  .alias('h', 'help')
  .help()
  .strict()
  .parseSync();

const normalizeRpcList = (values) => {
  if (!values) return [];
  const arr = Array.isArray(values) ? values : [values];
  const parsed = [];
  for (const entry of arr) {
    if (!entry) continue;
    parsed.push(
      ...entry
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    );
  }
  return [...new Set(parsed)];
};

const parseChainKeys = (value) => {
  if (!value) return [];
  return value
    .split(/[, \n\r\t]+/)
    .map((v) => v.trim())
    .filter(Boolean);
};

const RPC_URLS = normalizeRpcList(argv.rpcs);
const chainKeysFromArg = parseChainKeys(argv.chains);
const useChainMode = argv['all-chains'] || chainKeysFromArg.length > 0;

let chainsToProbe = [];
if (argv['all-chains']) {
  chainsToProbe = configuredChains;
} else if (chainKeysFromArg.length > 0) {
  chainsToProbe = getChainsByKeys(chainKeysFromArg);
}

if (!useChainMode && RPC_URLS.length === 0) {
  console.error('No RPC URLs provided. Use --rpcs or specify --chains/--all-chains.');
  process.exit(1);
}

if (useChainMode && chainsToProbe.length === 0) {
  console.error('No matching chains found for the provided selection.');
  process.exit(1);
}

const buildPayload = () => ({
  jsonrpc: '2.0',
  id: Date.now(),
  method: 'eth_callMany',
  params: [
    [
      {
        to: '0x0000000000000000000000000000000000000000',
        data: '0x',
      },
    ],
    'latest',
  ],
});

const METHOD_NOT_FOUND_CODES = new Set([-32601, -32004]);

const checkRpc = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildPayload()),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { status: 'error', message: `HTTP ${response.status} ${response.statusText}` };
    }

    const data = await response.json().catch(() => ({ error: { message: 'Invalid JSON response' } }));

    if (data?.error) {
      const code = Number(data.error.code);
      const message = data.error.message || 'Unknown error';
      if (METHOD_NOT_FOUND_CODES.has(code) || /method not found/i.test(message)) {
        return { status: 'unsupported', message };
      }
      return { status: 'supported', message: `Error response (likely due to params): ${message}` };
    }

    if (data?.result !== undefined) {
      return { status: 'supported', message: 'Received result' };
    }

    return { status: 'error', message: 'Unexpected response structure' };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { status: 'error', message: `Request timed out after ${timeoutMs}ms` };
    }
    return { status: 'error', message: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
};

async function runManualMode(rpcs) {
  console.log(`Checking eth_callMany support across ${rpcs.length} RPC URL(s)...`);
  console.log(`Timeout per request: ${argv.timeout} ms\n`);

  let supported = 0;
  let unsupported = 0;
  let errors = 0;

  for (const url of rpcs) {
    const result = await checkRpc(url, argv.timeout);
    if (result.status === 'supported') {
      supported += 1;
      console.log(`✅ ${url} supports eth_callMany (${result.message})`);
    } else if (result.status === 'unsupported') {
      unsupported += 1;
      console.log(`❌ ${url} does NOT support eth_callMany (${result.message})`);
    } else {
      errors += 1;
      console.log(`⚠️  ${url} request failed — ${result.message}`);
    }
  }

  console.log('\nSummary:');
  console.log(`  Supported   : ${supported}`);
  console.log(`  Unsupported : ${unsupported}`);
  console.log(`  Errors      : ${errors}`);
}

async function runChainMode(chains) {
  console.log(`Checking eth_callMany support across ${chains.length} chain(s) from chainconfig...`);
  console.log(`Timeout per request: ${argv.timeout} ms\n`);

  let chainsWithSupport = 0;
  const perChainResults = [];

  for (const chain of chains) {
    console.log(`\n=== ${chain.display || chain.name || chain.key} (${chain.key}) ===`);
    const rpcUrls = Array.isArray(chain.rpcUrls) ? chain.rpcUrls : [];
    if (rpcUrls.length === 0) {
      console.log('  ⚠️  No RPC URLs configured.');
      perChainResults.push({ key: chain.key, status: 'no-rpcs' });
      continue;
    }

    let found = null;
    let attempts = 0;
    for (const rpc of rpcUrls) {
      attempts += 1;
      const result = await checkRpc(rpc, argv.timeout);
      const prefix = `  [${attempts}/${rpcUrls.length}]`;
      if (result.status === 'supported') {
        found = { rpc, message: result.message };
        console.log(`${prefix} ✅ ${rpc} supports eth_callMany (${result.message})`);
        break;
      } else if (result.status === 'unsupported') {
        console.log(`${prefix} ❌ ${rpc} does NOT support eth_callMany (${result.message})`);
      } else {
        console.log(`${prefix} ⚠️  ${rpc} request failed — ${result.message}`);
      }
    }

    if (found) {
      chainsWithSupport += 1;
      perChainResults.push({ key: chain.key, status: 'supported', rpc: found.rpc, message: found.message });
    } else {
      console.log('  ✗ No RPC endpoint for this chain responded with eth_callMany support.');
      perChainResults.push({ key: chain.key, status: 'missing' });
    }
  }

  const missing = perChainResults.filter((r) => r.status !== 'supported');
  console.log('\nSummary:');
  console.log(`  Chains checked      : ${chains.length}`);
  console.log(`  Chains with support : ${chainsWithSupport}`);
  console.log(`  Chains missing      : ${missing.length}`);

  if (missing.length > 0) {
    console.log('\nChains lacking eth_callMany support:');
    missing.forEach((entry) => {
      const reason = entry.status === 'no-rpcs' ? 'no RPC URLs configured' : 'no supporting RPCs found';
      console.log(`  - ${entry.key}: ${reason}`);
    });
  }
}

async function main() {
  if (useChainMode) {
    await runChainMode(chainsToProbe);
  } else {
    await runManualMode(RPC_URLS);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err?.message || err);
  process.exit(1);
});
