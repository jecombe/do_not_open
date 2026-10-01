import { parseEther, parseUnits } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { PAYMENT_TOKENS } from "./deploy";
import { UNISWAP_V2 } from "./economy";

const ROUTER_ABI = [
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint, uint, uint)",
];
const FACTORY_ABI = ["function getPair(address, address) view returns (address)"];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function mint(address, uint256)",
];

/**
 * The USDC ramp: ETH in, USDC or cUSDC out, through a public pool, for a small fee. On Sepolia
 * no ETH/USDCMock pool exists, so one is opened here; its liquidity stays with the deployer.
 * Locally a fixed-price router stands in.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;
  const { ethers } = hre;
  const feeBps = Number(process.env.RAMP_FEE_BPS || "30");
  const owner = process.env.COLLECTION_OWNER || deployer;

  let payment = PAYMENT_TOKENS[hre.network.name];
  let router: string;
  const uniswap = UNISWAP_V2[hre.network.name];
  if (payment && uniswap) {
    router = uniswap.router;
    const signer = await ethers.getSigner(deployer);
    const factory = new ethers.Contract(uniswap.factory, FACTORY_ABI, signer);
    if ((await factory.getPair(uniswap.weth, payment.usdc)) === ethers.ZeroAddress) {
      const ethSide = parseEther(process.env.RAMP_LIQUIDITY_ETH || "0.1");
      const usdSide = parseUnits(process.env.RAMP_LIQUIDITY_USDC || "250", 6);
      const usdc = new ethers.Contract(payment.usdc, USDC_ABI, signer);
      const held: bigint = await usdc.balanceOf(deployer);
      if (held < usdSide) await (await usdc.mint(deployer, usdSide - held)).wait();
      await (await usdc.approve(router, usdSide)).wait();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const r = new ethers.Contract(router, ROUTER_ABI, signer);
      await (await r.addLiquidityETH(payment.usdc, usdSide, usdSide, ethSide, deployer, deadline, { value: ethSide })).wait();
      console.log(`ETH/USDC pool   : ${await factory.getPair(uniswap.weth, payment.usdc)} (${ethers.formatEther(ethSide)} ETH + ${ethers.formatUnits(usdSide, 6)} USDC)`);
    }
  } else {
    payment = { usdc: (await get("TestUSDC")).address, cUsdc: (await get("TestConfidentialUSDC")).address };
    router = (await deploy("TestSwapRouter", { from: deployer, args: [payment.usdc, parseUnits("2500", 6)], log: true })).address;
  }

  const ramp = await deploy("UsdcRamp", { from: deployer, args: [router, payment.usdc, payment.cUsdc, feeBps, owner], log: true });
  console.log(`UsdcRamp        : ${ramp.address} (fee ${feeBps / 100}%)`);
};
export default func;
func.id = "deploy_ramp";
func.tags = ["Ramp"];
func.dependencies = ["DoNotOpen"];
