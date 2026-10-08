import type { VaultDocsKey } from "./en";

export const vaultDocsFr: Record<VaultDocsKey, string> = {
  "vaultDocs.title": "Le coffre scellé, la documentation · DO NOT OPEN",
  "vaultDocs.description": "Comment marche le coffre scellé : un NFT dans une boîte dont le détenteur est chiffré, une clé que personne ne peut lire, des annonces Seaport avec le coffre comme vendeur, des ventes privées à prix secret, un relayer, et exactement ce qui fuite.",
  "vaultDocs.imageAlt": "Une boîte en carton scellée, tamponnée DO NOT OPEN, avec un NFT dedans",
  "vaultDocs.homeAria": "DO NOT OPEN, accueil",
  "vaultDocs.site": "Site",
  "vaultDocs.language": "Langue",
  "vaultDocs.contents": "Sommaire",
  "vaultDocs.nav.home": "Accueil",
  "vaultDocs.nav.project": "À propos de DO NOT OPEN",
  "vaultDocs.nav.vault": "Ouvrir le coffre",

  "vaultDocs.h1": "Le coffre scellé",
  "vaultDocs.lede": "N'importe quel NFT dans une boîte dont le détenteur est chiffré on-chain. Il peut quand même se vendre sur Seaport, ou en privé pour un prix que seul l'acheteur lit, et il sort vers n'importe quelle adresse. Voici comment, et ce que tout le monde peut encore voir.",
  "vaultDocs.hero.open": "Ouvrir le coffre",
  "vaultDocs.hero.leaks": "Ce qui fuite",

  "vaultDocs.section.what": "Ce qu'est le coffre",
  "vaultDocs.what.p1": "Un contrat qui garde des NFT. Chaque NFT qui entre reçoit une boîte : un jeton à part dont le détenteur est chiffré, comme les boîtes du jeu. Le NFT reste dedans jusqu'à ce que le détenteur de la boîte le sorte, le vende sur Seaport ou vende la boîte en privé.",
  "vaultDocs.what.p2": "Le coffre accepte les collections que son propriétaire autorise. Sur le réseau de test, c'est une collection de test gratuite que tout le monde peut minter.",

  "vaultDocs.section.seal": "Sceller un NFT",
  "vaultDocs.seal.p1": "Sceller tient en une transaction : le NFT entre dans le coffre et une boîte est créée pour lui, à votre nom. C'est public, puisque c'est un simple transfert de NFT : tout le monde voit qui a scellé quel NFT. Ce qui arrive ensuite à la boîte, non.",
  "vaultDocs.seal.p2": "Tant que la boîte ne bouge pas, son déposant en est le détenteur évident. Le doute vient avec un transfert : dès que des boîtes changent de mains, personne ne peut dire qui détient laquelle.",
  "vaultDocs.seal.p3": "Pour retrouver vos boîtes, la page lit vos propres reçus et déchiffre, pour vous seul, celles qui vous sont vraiment arrivées. Une signature.",

  "vaultDocs.section.key": "La clé de la boîte",
  "vaultDocs.key.p1": "Chaque boîte a une clé : un secret de 256 bits, stocké chiffré, que personne ne peut lire, vous compris. Le coffre ne fait jamais que la comparer. Tout ce qui sort du coffre (le NFT, une annonce, l'ETH d'une vente) se demande avec la clé, jamais avec votre adresse.",
  "vaultDocs.key.p2": "Vous ne tapez jamais la clé. Votre wallet signe un message fixe, gratuitement, et la page en tire la clé de chaque boîte : le même wallet fait les mêmes clés sur n'importe quel appareil. Ne signez ce message que sur DO NOT OPEN : qui obtient la signature peut sortir vos NFT.",
  "vaultDocs.key.p3": "Une clé n'est jamais envoyée telle quelle : elle est mêlée aux termes exacts de la demande (la boîte, l'action, l'adresse, le prix, la date de fin, et un compteur). Changez un terme, ou renvoyez la même demande plus tard, et la clé ne correspond plus : la demande est refusée.",
  "vaultDocs.key.p4": "Une boîte qui change de mains reçoit une clé au hasard, si bien que son ancien détenteur ne peut plus rien en faire. Son nouveau détenteur fait sienne la clé en une transaction (« Prendre la clé »). N'importe qui peut essayer, mais cela ne prend effet que pour le détenteur, et de l'extérieur les deux cas se ressemblent.",

  "vaultDocs.section.requests": "Demander quelque chose",
  "vaultDocs.requests.p1": "Sortir un NFT, le mettre en vente, retirer une annonce et encaisser l'ETH d'une vente se passent tous de la même façon, en deux temps. Une demande on-chain : le coffre vérifie la clé sous chiffrement. Puis une preuve du service de gestion des clés de Zama que la clé correspondait, que n'importe qui peut rapporter.",
  "vaultDocs.requests.p2": "La demande se règle de trois façons : faite ; refusée, quand la clé ne correspondait pas (rien ne se passe, rien n'échoue, donc un inconnu n'apprend rien) ; ou manquée, quand la boîte a changé entre-temps (vendue sur Seaport dans l'intervalle, par exemple).",
  "vaultDocs.requests.p3": "Tant qu'une demande attend sa preuve, la boîte est occupée : elle ne peut ni bouger ni recevoir une autre demande. Cela prend en général quelques secondes.",

  "vaultDocs.section.seaport": "Vendre sur Seaport",
  "vaultDocs.seaport.p1": "Une annonce est un vrai ordre Seaport 1.5, le protocole d'OpenSea, dont le vendeur est le coffre lui-même : votre adresse n'apparaît nulle part. Le coffre valide l'ordre on-chain, il ne signe donc rien, et seuls les ordres qu'il a validés peuvent vendre ses NFT.",
  "vaultDocs.seaport.p2": "N'importe quelle marketplace Seaport peut l'exécuter. L'acheteur paie en ETH et reçoit le NFT tout de suite. Les acheteurs voient le NFT, le prix et la date de fin, comme pour toute annonce.",
  "vaultDocs.seaport.p3": "L'ETH attend dans la boîte celui qui détient la clé, moins les frais du coffre ({fee} %, jamais plus de {max} %). Vous l'encaissez vers n'importe quelle adresse. Une annonce dure jusqu'à 180 jours ; une annonce expirée sans acheteur redevient scellée.",

  "vaultDocs.section.private": "Les ventes privées",
  "vaultDocs.private.p1": "Proposez une boîte à un seul acheteur, pour un prix en cUSDC (un dollar confidentiel) que vous seuls pouvez lire. L'acheteur le lit dans la page, puis paie et prend la boîte en une transaction.",
  "vaultDocs.private.p2": "Tout se règle sous chiffrement : si le prix est arrivé et que le vendeur détenait encore la boîte, la boîte bouge avec une clé qui est celle de l'acheteur, et le vendeur est payé ; sinon rien ne bouge et l'acheteur récupère ses cUSDC. Pour tous les autres, une vente qui a abouti et une vente ratée se ressemblent.",
  "vaultDocs.private.p3": "N'importe qui peut proposer n'importe quelle boîte, donc une offre ne prouve rien sur qui la détient. Le vendeur peut annuler une offre ouverte ; seul l'acheteur désigné peut l'accepter, une fois.",

  "vaultDocs.section.give": "Donner une boîte",
  "vaultDocs.give.p1": "Envoyez une boîte à n'importe quelle adresse. Elle ne bouge que si vous la détenez, et elle arrive sans clé : celui qui la reçoit la trouve dans ses reçus et fait sienne la clé. D'ici là, personne ne peut rien en sortir.",

  "vaultDocs.section.relayer": "Le relayer",
  "vaultDocs.relayer.p1": "Une demande envoyée depuis votre wallet montre votre adresse. L'API du site peut donc envoyer vos demandes et leurs preuves depuis son propre wallet, et payer le gas : alors votre adresse n'apparaît dans aucune transaction.",
  "vaultDocs.relayer.p2": "Il n'apprend rien que la chaîne ne montre pas. La clé lui arrive chiffrée pour le coffre et liée aux termes de la demande : il ne peut ni la lire, ni changer un terme, ni la réutiliser. Il voit, comme tout serveur web, l'IP d'où vient une demande.",
  "vaultDocs.relayer.p3": "Il peut refuser, pas tricher. Il a des limites par jour et par minute ; s'il est en panne ou dit non, la page envoie la demande depuis votre wallet, et vous prévient que votre adresse se voit alors.",

  "vaultDocs.section.leaks": "Ce qui est public, ce qui ne l'est pas",
  "vaultDocs.leaks.public": "Public",
  "vaultDocs.leaks.hidden": "Jamais public",
  "vaultDocs.leaks.public1": "Qui a scellé quel NFT (le dépôt est un transfert de NFT)",
  "vaultDocs.leaks.public2": "Le NFT dans chaque boîte, son état, son annonce",
  "vaultDocs.leaks.public3": "Les annonces et les achats Seaport, avec le coffre comme vendeur",
  "vaultDocs.leaks.public4": "L'adresse vers laquelle sort un NFT ou l'ETH d'une vente, et le montant",
  "vaultDocs.leaks.public5": "Qu'une demande a été faite, sur quelle boîte, pour quoi, et si elle a été faite, refusée ou manquée",
  "vaultDocs.leaks.public6": "Les deux adresses d'un transfert ou d'une vente privée",
  "vaultDocs.leaks.hidden1": "Qui détient une boîte",
  "vaultDocs.leaks.hidden2": "La clé de la boîte",
  "vaultDocs.leaks.hidden3": "Le prix d'une vente privée, et si elle a abouti",
  "vaultDocs.leaks.hidden4": "Si un transfert a déplacé quelque chose",
  "vaultDocs.leaks.hidden5": "Qui a demandé une annonce, un retrait ou un encaissement, quand le relayer l'envoie",
  "vaultDocs.leaks.p1": "En pratique : sortez vers une adresse sans historique, laissez le relayer envoyer vos demandes, et sachez que le moment choisi peut encore donner des indices (un « Prendre la clé » juste après un transfert vers la même adresse, par exemple).",

  "vaultDocs.section.testnet": "Sur le réseau de test",
  "vaultDocs.testnet.p1": "Le coffre tourne sur Sepolia, le réseau de test d'Ethereum, avec le vrai Seaport 1.5. Ses frais sont de {fee} %. La collection de test se mint gratuitement depuis la page du coffre ; rien ici ne vaut de l'argent.",
  "vaultDocs.testnet.c.vault": "Le coffre scellé",
  "vaultDocs.testnet.c.nft": "La collection de test gratuite",
  "vaultDocs.testnet.c.seaport": "Seaport 1.5",

  "vaultDocs.section.more": "Pour aller plus loin",
  "vaultDocs.more.project": "À propos de DO NOT OPEN",
  "vaultDocs.more.project.v": "L'idée, le chiffrement, à qui vous faites confiance.",
  "vaultDocs.more.design": "Les notes de conception",
  "vaultDocs.more.design.v": "Chaque flux, chaque vérification, chaque fuite, pour les développeurs.",
  "vaultDocs.more.contract": "Le contrat",
  "vaultDocs.more.contract.v": "SealedVault.sol, open source.",

  "vaultDocs.foot": "Le coffre scellé tourne sur un réseau de test. Rien ici ne vaut encore de l'argent.",
};
