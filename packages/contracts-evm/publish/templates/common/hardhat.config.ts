import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";

// Secrets live in .env (see .env.example). Nothing is hardcoded here.
dotenv.config();

// Hardhat's well-known test mnemonic: local networks only, never funded on a real chain.
const LOCAL_MNEMONIC = "test test test test test test test test test test test junk";

const sepoliaAccounts = process.env.PRIVATE_KEY
  ? [process.env.PRIVATE_KEY]
  : process.env.MNEMONIC
    ? { mnemonic: process.env.MNEMONIC, path: "m/44'/60'/0'/0/", count: 10 }
    : [];

const settings = { metadata: { bytecodeHash: "none" as const }, optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" };

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: { deployer: 0 },
  etherscan: { apiKey: { sepolia: process.env.ETHERSCAN_API_KEY ?? "" } },
  gasReporter: { currency: "USD", enabled: !!process.env.REPORT_GAS },
  networks: {
    hardhat: { accounts: { mnemonic: LOCAL_MNEMONIC }, chainId: 31337 },
    localhost: { accounts: { mnemonic: LOCAL_MNEMONIC }, chainId: 31337, url: "http://localhost:8545" },
    sepolia: {
      accounts: sepoliaAccounts,
      chainId: 11155111,
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      ...(process.env.SEPOLIA_GAS_PRICE ? { gasPrice: Number(process.env.SEPOLIA_GAS_PRICE) } : {}),
    },
  },
  paths: { artifacts: "./artifacts", cache: "./cache", sources: "./contracts", tests: "./test" },
  solidity: {
    compilers: [{ version: "0.8.27", settings }],
    overrides: {
      /* overrides */
    },
  },
  typechain: { outDir: "types", target: "ethers-v6" },
};

export default config;
