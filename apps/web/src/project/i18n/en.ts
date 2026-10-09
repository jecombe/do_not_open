/** English is the reference for the project's documentation: every other dictionary must hold exactly these keys. */
export const projectEn = {
  "project.title": "DO NOT OPEN, the documentation: confidential ownership on a public chain",
  "project.description": "What DO NOT OPEN is: sealed boxes on Ethereum whose holder and contents stay encrypted, thanks to Zama's FHE. The sealed vault for any NFT, the game of {supply} cats, what stays secret and who you trust.",
  "project.imageAlt": "A sealed cardboard box stamped DO NOT OPEN",
  "project.homeAria": "DO NOT OPEN, home",
  "project.site": "Site",
  "project.language": "Language",
  "project.contents": "Contents",
  "project.nav.home": "Home",
  "project.nav.vault": "The vault",
  "project.nav.game": "The game",

  "project.h1": "Confidential by default",
  "project.lede": "DO NOT OPEN puts what you own on Ethereum in sealed boxes: everyone can check the rules are kept, nobody can see who holds what. This page explains the idea, the two things built on it, and what stays secret.",
  "project.hero.vault": "The vault's docs",
  "project.hero.game": "The game's manual",

  "project.section.what": "What DO NOT OPEN is",
  "project.what.p1": "On a public blockchain everything is in the open: every wallet's NFTs, every sale, every balance, forever. Anyone can see what you hold, follow it, price it, and come after it.",
  "project.what.p2": "DO NOT OPEN is a confidentiality layer for that. Things go into boxes whose holder, and sometimes whose contents, are encrypted on-chain. The chain still enforces every rule: a box only moves if its holder moved it, a sale only settles if it was paid. It just never says who.",
  "project.what.p3": "Two products share that idea and the same contracts' base: the sealed vault, a serious tool for any NFT, and the game, 10,000 boxes with a cat in each, where the same encryption is put to work for fun.",

  "project.section.fhe": "How a box stays sealed",
  "project.fhe.p1": "The encryption is Zama's FHE (fully homomorphic encryption). A smart contract can add, compare and choose between encrypted values without ever reading them: \"is this caller the holder?\" gets an encrypted yes or no, and the box moves or not according to it.",
  "project.fhe.p2": "Nobody holds the key that would read everything. Zama's key management service splits it between several independent parties, who decrypt a value only when the contract allows it: to its holder alone, privately, or to everyone when the rules say it becomes public (a cat once its box is opened, a request that was accepted).",
  "project.fhe.p3": "Every reveal takes two steps: a request on-chain, then a proof signed by those parties that anyone can bring back. That is why some actions wait a few seconds for their proof.",

  "project.section.vault": "The sealed vault",
  "project.vault.p1": "Put any NFT of an allowed collection in a box. From then on nobody knows who holds the box: not the marketplaces, not the trackers, not us. The NFT itself stays visible; its holder does not.",
  "project.vault.p2": "The box can still be sold on Seaport, OpenSea's protocol, with the vault as the seller, or privately to one buyer for a price only the two of them can read. The NFT, or the ETH from a sale, comes out to any address, and a relayer can send the requests so the holder's address appears nowhere.",
  "project.vault.docs": "Read the vault's documentation",
  "project.vault.open": "Open the vault",

  "project.section.game": "The game",
  "project.game.p1": "{supply} sealed boxes, one cat in each, picked at random and encrypted the moment the box is made. Shake a box to get a private clue, open it to show the cat to everyone, duel, feed it croquettes, trade it at the flea market.",
  "project.game.p2": "Who holds which box, how many were sold and what is inside all stay encrypted, with the same contracts' base as the vault. The game is where the technology is put to work at scale, and where the community lives until mainnet.",
  "project.game.docs": "Read the game's manual",
  "project.game.open": "Play",

  "project.section.leaks": "What stays secret, what does not",
  "project.leaks.p1": "Encryption hides values, not the fact that something happened. A transaction is public: who sent it, to which contract, when. What DO NOT OPEN encrypts is what the transaction does: who ends up holding a box, a price agreed in private, whether a transfer moved anything.",
  "project.leaks.p2": "Some things are public on purpose. An NFT entering the vault is a plain NFT transfer, so the depositor shows. A Seaport listing shows its NFT and its price, with the vault as the seller. The address an NFT or a sale's ETH goes out to shows too: choose one with no history.",
  "project.leaks.p3": "Each product lists exactly what leaks, line by line, in its own documentation.",

  "project.section.trust": "Who you have to trust",
  "project.trust.p1": "The contracts: their code is open source, and they decide everything. Nobody, us included, can move a box, read a holder or change a past sale.",
  "project.trust.p2": "Zama's key management service, for what is decrypted and to whom: its parties would have to collude to read what the contracts did not allow. And for the vault's relayer, nothing: it cannot read a request or change it, only refuse to send it, and then your wallet sends it instead.",
  "project.trust.p3": "The contracts' owner can allow a collection in the vault and set its fee, within a cap written in the contract (10%). It cannot touch a box. Before mainnet, that ownership moves to a multisig.",

  "project.section.status": "Where it stands",
  "project.status.p1": "Everything runs on Sepolia, Ethereum's test network: test NFTs, test ETH, nothing with money in it. The game is live there with its community; the vault since October 2026.",
  "project.status.p2": "Mainnet comes once the contracts have been reviewed. The game's whitelist and its gifts carry over; the vault opens to real collections.",

  "project.section.more": "Further reading",
  "project.more.vault": "The vault's documentation",
  "project.more.vault.v": "Depositing, the key, Seaport, private sales, the relayer, what leaks.",
  "project.more.game": "The game's manual",
  "project.more.game.v": "Boxes, cats, croquettes, rats, the flea market, the testnet.",
  "project.more.repo": "The code",
  "project.more.repo.v": "Contracts, app and API, all open source.",
  "project.more.zama": "Zama's FHEVM",
  "project.more.zama.v": "The encryption the contracts run on.",

  "project.foot": "DO NOT OPEN runs on a test network. Nothing here is worth money yet.",
};

export type ProjectKey = keyof typeof projectEn;
