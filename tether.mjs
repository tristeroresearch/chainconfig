/// Source: https://tether.to/en/supported-protocols/
/// Native USDT deployments (EVM only)
export const tether = [
    {key: "ethereum", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7"},
    {key: "celo", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"},
    {key: "kaia", address: "0xd077a400968890eacc75cdc901f0356c943e4fdb"},
    {key: "avalanche", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7"},
    {key: "kava", address:"0x919C1c267BC06a7039e03fcc2eF738525769109c"}
];

/// Source: https://docs.usdt0.to/technical-documentation/developer/usdt0-deployments
/// USDT0 deployments - first address (the actual token) for each chain
export const usdt0 = [
    // Note: Ethereum uses OAdapterUpgradeable, not a direct token
    {key: "arbitrum_one", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"},
    {key: "polygon", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"},
    {key: "berachain", address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"},
    {key: "ink", address: "0x0200C29006150606B650577BBE7B6248F58470c1"},
    {key: "optimism", address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071"},
    {key: "unichain", address: "0x9151434b16b9763660705744891fA906F660EcC5"},
    {key: "corn", address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb"},
    {key: "sei", address: "0x9151434b16b9763660705744891fA906F660EcC5"},
    {key: "flare", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D"},
    {key: "hyperevm", address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb"},
    {key: "rootstock", address: "0x779dED0C9e1022225F8e0630b35A9B54Be713736"},
    {key: "xlayer", address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"},
    {key: "plasma", address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb"},
    {key: "conflux_espace", address: "0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff"},
    {key: "mantle", address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"},
    {key: "monad", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D"},
    {key: "stable", address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"},
];