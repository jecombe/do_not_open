# GitLab

Avatars for the GitLab group and its two repositories, where the contracts are published
(`packages/contracts-evm/publish`). 512×512, under GitLab's 200 KB. The group's and the vault's come in two
versions: **v1**, half the game and half the vault, and **v2**, the sealed vault first with the game as a nod
(the one in use).

| File | Where it goes |
| --- | --- |
| `group-v2.png` | The group's avatar (Settings, General, Group avatar): the X profile picture's drawing (`avatar-v2`), the sealed box (kraft with the vault's teal edges, a padlock on its tape, stamped DO NOT OPEN) with a cat's eyes behind its lid: the vault first, the game as a nod. `group-v1.png` is the first one: the box half cardboard (the game), half cipher (the vault) |
| `game.png` | The `game` repository (Settings, General, Project avatar): the box in cardboard, a cat peeking out |
| `vault-v2.png` | The `vault` repository: the sealed box taking in an NFT (one of the game's cats) and the confidential tokens (cUSDC, cWETH, cZAMA, each with the site's padlock). `vault-v1.png` is the first one: the box in cipher with its padlock and a stack of sealed coins |

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

> 🔐 What you own is nobody's business. DO NOT OPEN is a sealed vault on Ethereum, built on Zama's FHEVM: NFTs 🖼️, tokens 🪙 and Uniswap liquidity 🦄 held with their owner encrypted on-chain, still sold, paid and earning like any asset. 🐈‍⬛ Inside, a game: 10,000 sealed boxes, a cat in each. 📜 The Solidity contracts are published here from the main repository; the apps live at do-not-open.app 🌐

**`do-not-open-vault`**:

> 🔐 The sealed vault's contracts: 🖼️ any NFT in a box whose holder is encrypted on-chain, still sold on Seaport ⛵ with the vault as the seller, privately for a cUSDC price only the buyer reads 🤫, or lent through delegate.xyz 🤝; and 🪙 cUSDC, cUSDT, cWETH and cZAMA in pockets locked by a key 🔑, not an address, paid without showing who paid whom 👻. Zama FHEVM · Sepolia 🧪

**`do-not-open-game`**:

> 📦 The game's contracts: 10,000 confidential boxes, each with a cat 🐈 nobody can see, owners, balances and sale count encrypted on-chain 🔐. Open a box to meet its cat 👀, shake it 🫨, duel on the shelf ⚔️, feed the cats with CROQ 🍖, a confidential ERC-7984 token, and send rats 🐀 to play tricks. Zama FHEVM · Sepolia 🧪
