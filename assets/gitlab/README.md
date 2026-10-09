# GitLab

Avatars for the GitLab group and its two repositories, where the contracts are published
(`packages/contracts-evm/publish`). 512×512, under GitLab's 200 KB.

| File | Where it goes |
| --- | --- |
| `group.png` | The group's avatar (Settings, General, Group avatar): the X profile picture's drawing, the box half cardboard (the game), half cipher (the vault) |
| `game.png` | The `game` repository (Settings, General, Project avatar): the box in cardboard, a cat peeking out |
| `vault.png` | The `vault` repository: the box in cipher with its padlock, and a stack of sealed coins for the tokens |

Sources are the `.html` files next to them, SVG in the site's palette and its stencil font (loaded
from `node_modules`, so run `pnpm install` first). Render again with Chrome headless:

```bash
google-chrome --headless=new --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=1.28 --window-size=400,400 --screenshot=game.png "file://$PWD/game.html"
```

## Descriptions

Pasted in the same settings pages (Group description, Project description), under GitLab's
500-character limit for a group.

**Group** (`do-not-open`):

> Confidential assets on Ethereum, built on Zama's FHEVM. DO NOT OPEN is a sealed vault where NFTs and tokens are held with their owner encrypted on-chain, and a game of 10,000 sealed boxes with a cat in each. The Solidity contracts are published here from the main repository; the apps live at do-not-open.app.

**`do-not-open-vault`**:

> The sealed vault's contracts: any NFT in a box whose holder is encrypted on-chain, still sold on Seaport with the vault as the seller, privately for a cUSDC price only the buyer reads, or lent through delegate.xyz; and cUSDC in pockets locked by a key, not an address, paid without showing who paid whom. Zama FHEVM, Sepolia.

**`do-not-open-game`**:

> The game's contracts: 10,000 confidential boxes, each with a cat nobody can see, owners, balances and sale count encrypted on-chain. Open a box to meet its cat, shake it, duel on the shelf, feed the cats with CROQ, a confidential ERC-7984 token, and send rats to play tricks. Zama FHEVM, Sepolia.
