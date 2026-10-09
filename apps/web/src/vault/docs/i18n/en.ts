/** English is the reference for the vault's documentation: every other dictionary must hold exactly these keys. */
export const vaultDocsEn = {
  "vaultDocs.title": "The sealed vault, the documentation · DO NOT OPEN",
  "vaultDocs.description": "How the sealed vault works: an NFT in a box whose holder is encrypted, a key nobody can read, Seaport listings with the vault as the seller, private sales at a secret price, a relayer, and exactly what leaks.",
  "vaultDocs.imageAlt": "A sealed cardboard box stamped DO NOT OPEN, holding an NFT",
  "vaultDocs.homeAria": "DO NOT OPEN, home",
  "vaultDocs.site": "Site",
  "vaultDocs.language": "Language",
  "vaultDocs.contents": "Contents",
  "vaultDocs.nav.home": "Home",
  "vaultDocs.nav.vault": "Open the vault",

  "vaultDocs.h1": "The sealed vault",
  "vaultDocs.lede": "Any NFT in a box whose holder is encrypted on-chain. It can still be sold on Seaport, or privately for a price only the buyer reads, and it comes out to any address. Here is how, and what anyone can still see.",
  "vaultDocs.hero.open": "Open the vault",
  "vaultDocs.hero.leaks": "What leaks",

  "vaultDocs.section.what": "What the vault is",
  "vaultDocs.what.p1": "A contract that holds NFTs. Each NFT that goes in gets a box: a token of its own whose holder is encrypted, like the game's boxes. The NFT stays inside until the box's holder takes it out, sells it on Seaport, or sells the box privately.",
  "vaultDocs.what.p2": "The vault accepts the collections its owner allows. On the test network that is a free test collection anyone can mint.",

  "vaultDocs.section.seal": "Sealing an NFT",
  "vaultDocs.seal.p1": "Sealing is one transaction: the NFT moves into the vault and a box is made for it, held by you. It is public, since it is a plain NFT transfer: anyone sees who sealed which NFT. What happens to the box afterwards is not.",
  "vaultDocs.seal.p2": "The deposit names its depositor, but it can also send the new box on at once, in the same transaction, to a few random addresses where each transfer moves nothing (decoys: you pick how many, 0 to 5, 3 by default). Anyone sees the transfers, nobody sees which moved, so even the depositor is no longer the obvious holder. Without decoys, they are until the box moves.",
  "vaultDocs.seal.p3": "To find your boxes again, the page reads your own receipts and decrypts, for you alone, which ones really reached you. One signature.",

  "vaultDocs.section.key": "The box's key",
  "vaultDocs.key.p1": "Each box has a key: a 256-bit secret, stored encrypted, that nobody can read, you included. The vault only ever compares it. Anything that leaves the vault (the NFT, a listing, the ETH of a sale) is asked with the key, never with your address.",
  "vaultDocs.key.p2": "You never type the key. Your wallet signs one fixed message, free, and the page derives each box's key from that signature: the same wallet makes the same keys on any device. Sign that message only on DO NOT OPEN: whoever gets the signature can take your NFTs out.",
  "vaultDocs.key.p3": "A key is never sent as is: it is mixed with the exact terms of the request (the box, the action, the address, the price, the end date, and a counter). Change one term, or send the same request again later, and the key no longer matches: the request is refused.",
  "vaultDocs.key.p4": "A box that changes hands gets a random key, so its previous holder can do nothing more with it. Its new holder makes the key theirs with one transaction (\"Make the key mine\"). Anyone may try, but it only takes effect for the holder, and from the outside both look the same.",

  "vaultDocs.section.requests": "Asking for something",
  "vaultDocs.requests.p1": "Taking an NFT out, listing it, taking a listing down and collecting a sale's ETH all go the same way, in two steps. A request on-chain: the vault checks the key under encryption. Then a proof from Zama's key management service that the key matched, which anyone can bring back.",
  "vaultDocs.requests.p2": "The request settles one of four ways: done; refused, when the key did not match (nothing happens, nothing reverts, so a stranger learns nothing); missed, when the box changed in between (sold on Seaport meanwhile, say); or expired, when no proof came within a day (nothing happens).",
  "vaultDocs.requests.p3": "Requests do not lock each other out: a stranger who sends requests with a wrong key cannot stop you taking your NFT out, listing it or collecting. Each is decided on its own, and the counter the key is mixed with moves on only when a key matched, so a stranger's try spoils nothing you prepared. While any request waits for its proof, the box cannot change hands; the page settles the waiting ones first (anyone may), and one whose proof never comes can be expired by anyone after a day. No box stays stuck.",

  "vaultDocs.section.seaport": "Selling on Seaport",
  "vaultDocs.seaport.p1": "A listing is a real Seaport 1.5 order, OpenSea's protocol, whose seller is the vault itself: your address appears nowhere. The vault validates the order on-chain, so it signs nothing, and only the orders it validated can sell its NFTs.",
  "vaultDocs.seaport.p2": "Any Seaport marketplace can fill it. The buyer pays in ETH and gets the NFT straight away. Buyers see the NFT, the price and the end date, like any listing.",
  "vaultDocs.seaport.p3": "The ETH waits in the box for whoever holds the key, minus the vault's fee ({fee}%, never more than {max}%). You collect it to any address. A listing lasts up to 180 days; one that ran out without a buyer goes back to sealed.",

  "vaultDocs.section.private": "Private sales",
  "vaultDocs.private.p1": "Offer a box to one buyer, for a price in cUSDC (a confidential dollar) that only the two of you can read. The buyer reads it in the page, then pays and takes the box in one transaction.",
  "vaultDocs.private.p2": "Everything settles under encryption: if the price arrived and the seller still held the box, the box moves with a key that is the buyer's, and the seller is paid; otherwise nothing moves and the buyer gets their cUSDC back. To everyone else, a sale that went through and one that did not look the same.",
  "vaultDocs.private.p3": "Anyone may offer any box, so an offer proves nothing about who holds it. The seller can cancel an open offer; only the named buyer can accept it, once.",

  "vaultDocs.section.give": "Giving a box",
  "vaultDocs.give.p1": "Send a box to any address. It only moves if you hold it, and it arrives without a key: the receiver finds it in their receipts and makes the key theirs. Until then nobody can take anything out of it.",

  "vaultDocs.section.relayer": "The relayer",
  "vaultDocs.relayer.p1": "A request sent from your wallet shows your address. So the site's API can send your requests and their proofs from its own wallet, and pay the gas: then your address appears in no transaction.",
  "vaultDocs.relayer.p2": "It learns nothing the chain does not show. The key reaches it encrypted for the vault and bound to the request's terms: it can neither read it, nor change a term, nor reuse it. It sees, like any web server, the IP a request comes from.",
  "vaultDocs.relayer.p3": "It can refuse, not cheat. It has limits a day and a minute; if it is down or says no, the page sends the request from your wallet, and tells you your address then shows.",

  "vaultDocs.section.leaks": "What is public, what is not",
  "vaultDocs.leaks.public": "Public",
  "vaultDocs.leaks.hidden": "Never public",
  "vaultDocs.leaks.public1": "Who sealed which NFT (the deposit is an NFT transfer), and the addresses its decoys went to",
  "vaultDocs.leaks.public2": "The NFT inside each box, its state, its listing",
  "vaultDocs.leaks.public3": "Seaport listings and purchases, with the vault as the seller",
  "vaultDocs.leaks.public4": "The address an NFT or a sale's ETH goes out to, and the amount",
  "vaultDocs.leaks.public5": "That a request was made, on which box, for what, and whether it was done, refused, missed or expired",
  "vaultDocs.leaks.public6": "The two addresses of a transfer or a private sale",
  "vaultDocs.leaks.hidden1": "Who holds a box",
  "vaultDocs.leaks.hidden2": "The box's key",
  "vaultDocs.leaks.hidden3": "A private sale's price, and whether it went through",
  "vaultDocs.leaks.hidden4": "Whether a transfer moved anything",
  "vaultDocs.leaks.hidden5": "Who asked for a listing, a withdrawal or a payout, when the relayer sends it",
  "vaultDocs.leaks.p1": "In practice: take things out to an address with no history, let the relayer send your requests, and know that timing can still give hints (a \"Make the key mine\" right after a transfer to the same address, say).",

  "vaultDocs.section.testnet": "On the test network",
  "vaultDocs.testnet.p1": "The vault runs on Sepolia, Ethereum's test network, with the real Seaport 1.5. Its fee is {fee}%. The test collection is free to mint from the vault's page; nothing here is worth money.",
  "vaultDocs.testnet.c.vault": "The sealed vault",
  "vaultDocs.testnet.c.nft": "The free test collection",
  "vaultDocs.testnet.c.seaport": "Seaport 1.5",

  "vaultDocs.section.more": "Further reading",
  "vaultDocs.more.project": "About DO NOT OPEN",
  "vaultDocs.more.project.v": "The idea, the encryption, who you trust.",
  "vaultDocs.more.design": "The design notes",
  "vaultDocs.more.design.v": "Every flow, every check, every leak, for developers.",
  "vaultDocs.more.contract": "The contract",
  "vaultDocs.more.contract.v": "SealedVault.sol, open source.",

  "vaultDocs.foot": "The sealed vault runs on a test network. Nothing here is worth money yet.",
};

export type VaultDocsKey = keyof typeof vaultDocsEn;
