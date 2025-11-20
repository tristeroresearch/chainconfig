# Chain Configuration

Centralized chain configuration and integrity checking for the Create5 project.

## Structure

- `chains.mjs` - Main chain configuration file
- `scripts/integrity_check.mjs` - Integrity checker tool
- `scripts/abis/` - Contract ABI definitions for verification
- `package.json` - Dependencies for the submodule

## Installation

```bash
cd chainconfig
npm install
```

## Usage

The integrity checker provides several commands to validate your chain configuration:

### Basic Integrity Check

Check for duplicate keys, chainIds, and LayerZero IDs:

```bash
npm run check
# or
node scripts/integrity_check.mjs check
```

### Verify RPC URLs

Test all RPC URLs for connectivity and chainId accuracy:

```bash
npm run verify-rpcs
# or
node scripts/integrity_check.mjs verify-rpcs
```

### Verify Contract Interfaces

Verify that configured contract addresses implement the expected interfaces:

```bash
npm run verify-contracts
# or
node scripts/integrity_check.mjs verify-contracts
```

### Full Check and Auto-Fix

Run all checks and generate a corrected configuration file:

```bash
npm run fix
# or
node scripts/integrity_check.mjs fix
```

This will create `chains-corrected.mjs` with suggested fixes. Review the file before replacing the original configuration.

### Fetch Gas.zip Chains

Fetch all chains supported by gas.zip and generate a list of chains not in your config:

```bash
npm run fetch-gaszip
# or
node scripts/fetch_gaszip_chains.mjs
```

This will create three separate files based on EVM compatibility verification:

- **`gz-chains-evm.mjs`** - Confirmed EVM-compatible chains (exports `gaszipEvmChains` object)
- **`gz-chains-non-evm.mjs`** - Confirmed non-EVM chains (exports `gaszipNonEvmChains` object)
- **`gz-chains-error.mjs`** - Chains that couldn't be verified (exports `gaszipErrorChains` object)

Each file exports an object keyed by chain key, making it easy to merge into your main `chainConfig`.

The script:
- Fetches chain definitions from the gas.zip API (mainnet only)
- Tests each chain's RPC endpoint for EVM compatibility
- Converts them to your config format
- Filters out chains already in your config (by chainId)
- Generates properly formatted chain objects with default contract addresses
- Separates chains into three files based on verification status

⚠️ **Note:** Chains in `gz-chains-error.mjs` require manual verification via block explorer before adding to your config.

### Fetch Chainlist RPCs

Extend your existing chains with additional RPC URLs and explorers from chainlist.org:

```bash
npm run fetch-chainlist
# or
node scripts/fetch_chainlist_rpcs.mjs
```

This will create `chains-updated.mjs` with enhanced chain configurations:

- **Additional RPC URLs** - Privacy-friendly HTTPS endpoints (no tracking or tracking: "none")
- **Multiple Explorer URLs** - All available block explorers from chainlist.org
- **New Fields**:
  - `explorerUrls` - Array of all explorer URLs
  - `defaultExplorerUrlIndex` - Index of the preferred explorer (default: 0)
  - `explorerUrl` - Kept for backwards compatibility

The script:
- Fetches chain data from chainlist.org API
- Matches chains by `chainId` with your existing config
- Adds new RPC URLs (only HTTPS, no tracking)
- Adds new explorer URLs from chainlist.org
- Preserves all existing chain data
- Generates `chains-updated.mjs` with enhanced configurations

**Usage:**
1. Run the script to generate `chains-updated.mjs`
2. Review the changes
3. If satisfied, replace `chains.mjs` with `chains-updated.mjs`

⚠️ **Note:** The original `chains.mjs` is never modified directly. Always review the generated file before replacing.

## Features

### RPC Verification
- Tests all configured RPC URLs for connectivity
- Verifies chainId matches configuration
- Suggests optimal `defaultRpcUrlIndex` based on working RPCs
- Detects chainId mismatches

### Contract Verification
- Verifies contract interfaces match expected ABIs:
  - **WETH** - Wrapped gas token
  - **Permit2** - Universal permit contract
  - **Entry Point** - ERC-4337 account abstraction
  - **Trusted Forwarder** - Meta-transaction forwarder
  - **Relay Router** - Cross-chain relay router
  - **Message Transmitter** - CCTP message transmitter
  - **Token Messenger** - CCTP token messenger

### Smart Defaults
- If a contract is set to zero address but the default address is deployed, it will suggest using the default
- Default addresses:
  - Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`
  - Entry Point: `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`
  - Trusted Forwarder: `0xB2b5841DBeF766d4b521221732F9B618fCf34A87`
  - Relay Router: `0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222`
  - Message Transmitter: `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`
  - Token Messenger: `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`

## Output

The tool provides:
- ✓ Success indicators for passing checks
- ✗ Error indicators for failures
- ℹ Informational suggestions for improvements
- ⚠ Warnings for potential issues
- JSON output of suggested corrections

## Example Output

```
=== Basic Integrity Checks ===
✓ No duplicate keys, chainIds, or LayerZero IDs found

=== RPC Verification ===

Checking Ethereum (ethereum)...
  [0] https://eth-mainnet.public.blastapi.io... ✓ OK

Checking Arbitrum One (arbitrum_one)...
  [0] https://arb1.arbitrum.io/rpc... ✓ OK

=== Contract Verification ===

Verifying contracts for Ethereum (ethereum)...
  WETH                 ✓ 0xC02aaA39...
  PERMIT2              ✓ 0x00000000...
  ENTRY_POINT          ✓ 0x43370844...
  ...

✓ Corrections applied. Review chains-corrected.mjs before using.
```
