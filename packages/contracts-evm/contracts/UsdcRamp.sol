// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";

/// @dev The slice of a Uniswap V2 router the ramp uses.
interface ISwapRouter {
    function WETH() external view returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

/// @title USDC ramp
/// @notice Buys USDC with ETH on a public pool in one transaction, and can hand it over
///         already shielded as cUSDC. Takes a small fee, in ETH, before the swap.
/// @dev Shielding USDC the buyer already holds does not go through here: they call the cUSDC
///      wrapper themselves, for free. What a purchase moves is public either way: ETH in, USDC
///      out, and the wrapped amount. Only what happens to cUSDC afterwards is private.
contract UsdcRamp is Ownable {
    using SafeERC20 for IERC20;

    /// @notice The fee can never be set above 1%.
    uint16 public constant MAX_FEE_BPS = 100;

    ISwapRouter public immutable router;
    IERC20 public immutable usdc;
    IERC7984ERC20Wrapper public immutable confidentialUsdc;
    uint16 public immutable feeBps;
    /// @notice ETH fees not withdrawn yet.
    uint256 public fees;

    error FeeTooHigh();
    error NothingToWithdraw();
    error TransferFailed();

    event Bought(address indexed buyer, uint256 ethIn, uint256 fee, uint256 usdcOut, bool shielded);

    constructor(
        ISwapRouter router_,
        IERC20 usdc_,
        IERC7984ERC20Wrapper confidentialUsdc_,
        uint16 feeBps_,
        address owner_
    ) Ownable(owner_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        router = router_;
        usdc = usdc_;
        confidentialUsdc = confidentialUsdc_;
        feeBps = feeBps_;
    }

    /// @notice What `ethIn` buys after the fee, before slippage.
    function quote(uint256 ethIn) external view returns (uint256 usdcOut, uint256 fee) {
        fee = (ethIn * feeBps) / 10_000;
        uint256[] memory amounts = router.getAmountsOut(ethIn - fee, _path());
        usdcOut = amounts[1];
    }

    /// @notice Swaps the ETH sent, minus the fee, for at least `minUsdcOut` USDC. With `shield`,
    ///         the USDC is wrapped and the caller receives cUSDC instead.
    function buy(uint256 minUsdcOut, bool shield, uint256 deadline) external payable returns (uint256 usdcOut) {
        uint256 fee = (msg.value * feeBps) / 10_000;
        fees += fee;
        address to = shield ? address(this) : msg.sender;
        uint256[] memory amounts = router.swapExactETHForTokens{value: msg.value - fee}(minUsdcOut, _path(), to, deadline);
        usdcOut = amounts[1];
        if (shield) {
            usdc.forceApprove(address(confidentialUsdc), usdcOut);
            confidentialUsdc.wrap(msg.sender, usdcOut);
        }
        emit Bought(msg.sender, msg.value, fee, usdcOut, shield);
    }

    function withdrawFees(address payable to) external onlyOwner {
        uint256 amount = fees;
        if (amount == 0) revert NothingToWithdraw();
        fees = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _path() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(usdc);
    }
}
