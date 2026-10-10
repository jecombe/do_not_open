import type { ProjectKey } from "./en";

export const projectFr: Record<ProjectKey, string> = {
  "project.title": "DO NOT OPEN, la documentation : la propriété confidentielle sur une chaîne publique",
  "project.description": "Ce qu'est DO NOT OPEN : des boîtes scellées sur Ethereum dont le détenteur et le contenu restent chiffrés, grâce au FHE de Zama. Le coffre scellé pour n'importe quel NFT, le jeu de {supply} chats, ce qui reste secret et à qui vous faites confiance.",
  "project.imageAlt": "Une boîte en carton scellée, tamponnée DO NOT OPEN",
  "project.homeAria": "DO NOT OPEN, accueil",
  "project.site": "Site",
  "project.language": "Langue",
  "project.contents": "Sommaire",
  "project.nav.home": "Accueil",
  "project.nav.vault": "Le coffre",
  "project.nav.game": "Le jeu",

  "project.h1": "Confidentiel par défaut",
  "project.lede": "DO NOT OPEN met ce que vous possédez sur Ethereum dans des boîtes scellées : tout le monde peut vérifier que les règles sont tenues, personne ne voit qui détient quoi. Cette page explique l'idée, les deux choses construites dessus, et ce qui reste secret.",
  "project.hero.vault": "La doc du coffre",
  "project.hero.game": "Le manuel du jeu",

  "project.section.what": "Ce qu'est DO NOT OPEN",
  "project.what.p1": "Sur une blockchain publique, tout est à découvert : les NFT de chaque wallet, chaque vente, chaque solde, pour toujours. N'importe qui peut voir ce que vous détenez, le suivre, l'estimer, et venir le chercher.",
  "project.what.p2": "DO NOT OPEN est une couche de confidentialité pour ça. Les choses vont dans des boîtes dont le détenteur, et parfois le contenu, sont chiffrés on-chain. La chaîne fait toujours respecter chaque règle : une boîte ne bouge que si son détenteur l'a bougée, une vente ne se règle que si elle a été payée. Elle ne dit simplement jamais qui.",
  "project.what.p3": "Deux produits partagent cette idée et la même base de contrats : le coffre scellé, un vrai outil pour n'importe quel NFT, et le jeu, 10 000 boîtes avec un chat dans chacune, où le même chiffrement sert à s'amuser.",

  "project.section.fhe": "Comment une boîte reste scellée",
  "project.fhe.p1": "Le chiffrement est le FHE de Zama (chiffrement totalement homomorphe). Un smart contract peut additionner, comparer et choisir entre des valeurs chiffrées sans jamais les lire : « cet appelant est-il le détenteur ? » reçoit un oui ou un non chiffré, et la boîte bouge ou non selon la réponse.",
  "project.fhe.p2": "Personne ne détient la clé qui lirait tout. Le service de gestion des clés de Zama la partage entre plusieurs parties indépendantes, qui ne déchiffrent une valeur que lorsque le contrat l'autorise : pour son seul détenteur, en privé, ou pour tout le monde quand les règles disent qu'elle devient publique (un chat une fois sa boîte ouverte, une demande acceptée).",
  "project.fhe.p3": "Chaque révélation se fait en deux temps : une demande on-chain, puis une preuve signée par ces parties, que n'importe qui peut rapporter. C'est pourquoi certaines actions attendent leur preuve quelques secondes.",

  "project.section.vault": "Le coffre scellé",
  "project.vault.p1": "Mettez n'importe quel NFT dans une boîte. Dès lors, personne ne sait qui détient la boîte : ni les marketplaces, ni les trackers, ni nous. Le NFT reste visible ; son détenteur, non.",
  "project.vault.p2": "La boîte peut quand même se vendre sur Seaport, le protocole d'OpenSea, avec le coffre comme vendeur (sur le réseau principal, l'annonce s'affiche sur OpenSea), ou en privé à un seul acheteur pour un prix que vous seuls pouvez lire. Le NFT, ou l'ETH d'une vente, sort vers n'importe quelle adresse, et un relayer peut envoyer les demandes pour que l'adresse du détenteur n'apparaisse nulle part.",
  "project.vault.p3": "Le coffre garde aussi des jetons. Tes cUSDC, un dollar confidentiel, vont dans une poche verrouillée par une clé plutôt que par une adresse : envoie-les vers une autre poche, paie une boîte avec, ou sors-les où tu veux. Les jetons confidentiels cachent déjà les montants ; une poche cache aussi qui a payé qui. Les cUSDT, cWETH et cZAMA, les autres jetons confidentiels de Zama, ont leurs propres poches ; les boîtes se paient en cUSDC.",
  "project.vault.docs": "Lire la doc du coffre",
  "project.vault.open": "Ouvrir le coffre",

  "project.section.game": "Le jeu",
  "project.game.p1": "{supply} boîtes scellées, un chat dans chacune, tiré au sort et chiffré au moment où la boîte est fabriquée. Secouez une boîte pour obtenir un indice privé, ouvrez-la pour montrer le chat à tous, faites des duels, nourrissez-le de croquettes, échangez-le au marché aux puces.",
  "project.game.p2": "Qui détient quelle boîte, combien ont été vendues et ce qu'il y a dedans restent chiffrés, avec la même base de contrats que le coffre. Le jeu est l'endroit où la technologie travaille à grande échelle, et où vit la communauté jusqu'au mainnet.",
  "project.game.docs": "Lire le manuel du jeu",
  "project.game.open": "Jouer",

  "project.section.leaks": "Ce qui reste secret, ce qui ne l'est pas",
  "project.leaks.p1": "Le chiffrement cache des valeurs, pas le fait que quelque chose s'est passé. Une transaction est publique : qui l'a envoyée, vers quel contrat, quand. Ce que DO NOT OPEN chiffre, c'est ce que fait la transaction : qui finit par détenir une boîte, un prix convenu en privé, si un transfert a déplacé quelque chose.",
  "project.leaks.p2": "Certaines choses sont publiques exprès. Un NFT qui entre dans le coffre est un simple transfert de NFT, donc le déposant se voit. Une annonce Seaport montre son NFT et son prix, avec le coffre comme vendeur, sur OpenSea sur le réseau principal. L'adresse vers laquelle sort un NFT ou l'ETH d'une vente se voit aussi : choisissez-en une sans historique.",
  "project.leaks.p3": "Chaque produit liste exactement ce qui fuite, ligne par ligne, dans sa propre documentation.",

  "project.section.trust": "À qui vous faites confiance",
  "project.trust.p1": "Aux contrats : leur code est open source, et ce sont eux qui décident de tout. Personne, nous compris, ne peut déplacer une boîte, lire un détenteur ou modifier une vente passée.",
  "project.trust.p2": "Au service de gestion des clés de Zama, pour ce qui est déchiffré et pour qui : ses parties devraient s'entendre pour lire ce que les contrats n'ont pas autorisé. Et au relayer du coffre, pour rien : il ne peut ni lire une demande ni la modifier, seulement refuser de l'envoyer, et alors votre wallet l'envoie à sa place.",
  "project.trust.p3": "Le propriétaire des contrats peut autoriser une collection dans le coffre et fixer ses frais, dans une limite écrite dans le contrat (10 %). Il ne peut pas toucher à une boîte. Avant le mainnet, cette propriété passe à un multisig.",

  "project.section.status": "Où on en est",
  "project.status.p1": "Tout tourne sur Sepolia, le réseau de test d'Ethereum : NFT de test, ETH de test, rien qui contienne de l'argent. Le jeu y est en ligne avec sa communauté ; le coffre depuis octobre 2026.",
  "project.status.p2": "Le mainnet viendra une fois les contrats relus. La whitelist du jeu et ses cadeaux sont conservés ; le coffre s'ouvre aux vraies collections.",

  "project.section.more": "Pour aller plus loin",
  "project.more.vault": "La doc du coffre",
  "project.more.vault.v": "Le dépôt, la clé, Seaport, les ventes privées, les poches, le relayer, ce qui fuite.",
  "project.more.game": "Le manuel du jeu",
  "project.more.game.v": "Les boîtes, les chats, les croquettes, les rats, le marché aux puces, le testnet.",
  "project.more.repo": "Le code",
  "project.more.repo.v": "Les contrats du jeu et du coffre, leurs tests et leurs adresses, open source sur GitLab.",
  "project.more.zama": "Le FHEVM de Zama",
  "project.more.zama.v": "Le chiffrement sur lequel tournent les contrats.",

  "project.foot": "DO NOT OPEN tourne sur un réseau de test. Rien ici ne vaut encore de l'argent.",
};
