// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice The two calls the locker makes on Uniswap V3's NonfungiblePositionManager.
interface IUniswapV3PositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title Liquidity locker
/// @notice Holds Uniswap V3 positions for good. Nothing in it removes liquidity, moves a position
///         out or burns one, so the market a position seeds stays open whoever owns the collection.
///         The trading fees the positions earn are its only output: anyone can send them to the
///         beneficiary, and the owner can only choose who that is.
contract LiquidityLocker is IERC721Receiver, Ownable2Step {
    IUniswapV3PositionManager public immutable positionManager;
    /// @notice Where collected fees go.
    address public beneficiary;
    uint256[] private _positions;

    event Locked(uint256 indexed positionId, address indexed from);
    event FeesCollected(uint256 indexed positionId, address indexed to, uint256 amount0, uint256 amount1);
    event BeneficiaryChanged(address indexed previous, address indexed next);

    error NotPositionManager();
    error NotHeld(uint256 positionId);
    error ZeroAddress();

    constructor(IUniswapV3PositionManager positionManager_, address beneficiary_, address owner_) Ownable(owner_) {
        if (address(positionManager_) == address(0) || beneficiary_ == address(0)) revert ZeroAddress();
        positionManager = positionManager_;
        beneficiary = beneficiary_;
        emit BeneficiaryChanged(address(0), beneficiary_);
    }

    /// @notice Takes a position sent with `safeTransferFrom`. Only the position manager's own NFTs
    ///         are accepted: anything else would be stuck here.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        _positions.push(tokenId);
        emit Locked(tokenId, from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Sends a held position's earned fees to the beneficiary. Anyone can call it; the
    ///         liquidity itself does not move.
    function collect(uint256 positionId) external returns (uint256 amount0, uint256 amount1) {
        if (positionManager.ownerOf(positionId) != address(this)) revert NotHeld(positionId);
        address to = beneficiary;
        (amount0, amount1) = positionManager.collect(
            IUniswapV3PositionManager.CollectParams(positionId, to, type(uint128).max, type(uint128).max)
        );
        emit FeesCollected(positionId, to, amount0, amount1);
    }

    function setBeneficiary(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit BeneficiaryChanged(beneficiary, next);
        beneficiary = next;
    }

    /// @notice Every position received through `safeTransferFrom`, in order.
    function positions() external view returns (uint256[] memory) {
        return _positions;
    }
}
