import type { VaultDocsKey } from "./en";

export const vaultDocsIt: Record<VaultDocsKey, string> = {
  "vaultDocs.title": "Il caveau sigillato, la documentazione · DO NOT OPEN",
  "vaultDocs.description": "Come funziona il caveau sigillato: un NFT in una scatola il cui detentore è cifrato, una chiave che nessuno può leggere, annunci su Seaport con il caveau come venditore, vendite private a un prezzo segreto, un relayer, ed esattamente cosa trapela.",
  "vaultDocs.imageAlt": "Una scatola di cartone sigillata col timbro DO NOT OPEN, con dentro un NFT",
  "vaultDocs.homeAria": "DO NOT OPEN, home",
  "vaultDocs.site": "Sito",
  "vaultDocs.language": "Lingua",
  "vaultDocs.contents": "Indice",
  "vaultDocs.nav.home": "Home",
  "vaultDocs.nav.vault": "Apri il caveau",

  "vaultDocs.h1": "Il caveau sigillato",
  "vaultDocs.lede": "Qualsiasi NFT in una scatola il cui detentore è cifrato on-chain. Si può comunque vendere su Seaport, o in privato a un prezzo che legge solo l'acquirente, ed esce verso qualsiasi indirizzo. Ecco come, e cosa chiunque può ancora vedere.",
  "vaultDocs.hero.open": "Apri il caveau",
  "vaultDocs.hero.leaks": "Cosa trapela",

  "vaultDocs.section.what": "Cos'è il caveau",
  "vaultDocs.what.p1": "Un contratto che custodisce NFT. Ogni NFT che entra riceve una scatola: un token a sé il cui detentore è cifrato, come le scatole del gioco. L'NFT resta dentro finché il detentore della scatola non lo tira fuori, lo vende su Seaport o vende la scatola in privato.",
  "vaultDocs.what.p2": "Il caveau accetta le collezioni che il suo proprietario ammette. Sulla rete di prova è una collezione di prova gratuita che chiunque può coniare.",

  "vaultDocs.section.seal": "Sigillare un NFT",
  "vaultDocs.seal.p1": "Sigillare è una sola transazione: l'NFT entra nel caveau e viene creata una scatola per lui, detenuta da te. È pubblica, perché è un semplice trasferimento di NFT: tutti vedono chi ha sigillato quale NFT. Quello che succede dopo alla scatola, no.",
  "vaultDocs.seal.p2": "Finché la scatola non si sposta, chi l'ha depositata è il suo detentore ovvio. Il dubbio arriva con un trasferimento: appena le scatole cambiano mano, nessuno può dire chi detiene quale.",
  "vaultDocs.seal.p3": "Per ritrovare le tue scatole, la pagina legge le tue ricevute e decifra, solo per te, quali ti sono arrivate davvero. Una firma.",

  "vaultDocs.section.key": "La chiave della scatola",
  "vaultDocs.key.p1": "Ogni scatola ha una chiave: un segreto di 256 bit, conservato cifrato, che nessuno può leggere, nemmeno tu. Il caveau si limita a confrontarla. Tutto ciò che esce dal caveau (l'NFT, un annuncio, l'ETH di una vendita) si chiede con la chiave, mai con il tuo indirizzo.",
  "vaultDocs.key.p2": "Non digiti mai la chiave. Il tuo wallet firma un messaggio fisso, gratis, e la pagina ricava da quella firma la chiave di ogni scatola: lo stesso wallet genera le stesse chiavi su qualsiasi dispositivo. Firma quel messaggio solo su DO NOT OPEN: chi ottiene la firma può tirare fuori i tuoi NFT.",
  "vaultDocs.key.p3": "Una chiave non viene mai inviata così com'è: viene mescolata con i termini esatti della richiesta (la scatola, l'azione, l'indirizzo, il prezzo, la data di fine e un contatore). Cambia un termine, o invia di nuovo la stessa richiesta più tardi, e la chiave non corrisponde più: la richiesta viene rifiutata.",
  "vaultDocs.key.p4": "Una scatola che cambia mano riceve una chiave casuale, così il suo detentore precedente non può più farci niente. Il nuovo detentore fa sua la chiave con una transazione («Prendi la chiave»). Chiunque può provarci, ma ha effetto solo per il detentore, e da fuori le due cose sembrano uguali.",

  "vaultDocs.section.requests": "Chiedere qualcosa",
  "vaultDocs.requests.p1": "Tirare fuori un NFT, metterlo in vendita, ritirare un annuncio e incassare l'ETH di una vendita funzionano allo stesso modo, in due passi. Una richiesta on-chain: il caveau verifica la chiave sotto cifratura. Poi una prova del servizio di gestione delle chiavi di Zama che la chiave corrispondeva, che chiunque può riportare.",
  "vaultDocs.requests.p2": "La richiesta si chiude in uno di tre modi: eseguita; rifiutata, quando la chiave non corrispondeva (non succede niente, niente fa revert, quindi un estraneo non scopre nulla); o mancata, quando la scatola è cambiata nel frattempo (venduta su Seaport intanto, per esempio).",
  "vaultDocs.requests.p3": "Mentre una richiesta aspetta la sua prova la scatola è occupata: non può spostarsi né ricevere un'altra richiesta. Di solito ci vogliono pochi secondi.",

  "vaultDocs.section.seaport": "Vendere su Seaport",
  "vaultDocs.seaport.p1": "Un annuncio è un vero ordine Seaport 1.5, il protocollo di OpenSea, il cui venditore è il caveau stesso: il tuo indirizzo non compare da nessuna parte. Il caveau convalida l'ordine on-chain, quindi non firma niente, e solo gli ordini che ha convalidato possono vendere i suoi NFT.",
  "vaultDocs.seaport.p2": "Qualsiasi marketplace Seaport può eseguirlo. L'acquirente paga in ETH e riceve subito l'NFT. Chi compra vede l'NFT, il prezzo e la data di fine, come in qualsiasi annuncio.",
  "vaultDocs.seaport.p3": "L'ETH aspetta nella scatola chi ha la chiave, meno la commissione del caveau ({fee}%, mai più del {max}%). Lo incassi verso qualsiasi indirizzo. Un annuncio dura fino a 180 giorni; uno scaduto senza acquirente torna sigillato.",

  "vaultDocs.section.private": "Vendite private",
  "vaultDocs.private.p1": "Offri una scatola a un solo acquirente, a un prezzo in cUSDC (un dollaro riservato) che solo voi due potete leggere. L'acquirente lo legge nella pagina, poi paga e prende la scatola in una sola transazione.",
  "vaultDocs.private.p2": "Tutto si chiude sotto cifratura: se il prezzo è arrivato e il venditore aveva ancora la scatola, la scatola si sposta con una chiave che è dell'acquirente, e il venditore viene pagato; altrimenti non si muove niente e l'acquirente riceve indietro i suoi cUSDC. Per tutti gli altri, una vendita andata in porto e una no sembrano uguali.",
  "vaultDocs.private.p3": "Chiunque può offrire qualsiasi scatola, quindi un'offerta non prova niente su chi la detiene. Il venditore può annullare un'offerta aperta; solo l'acquirente indicato può accettarla, una volta.",

  "vaultDocs.section.give": "Regalare una scatola",
  "vaultDocs.give.p1": "Manda una scatola a qualsiasi indirizzo. Si sposta solo se la detieni, e arriva senza chiave: chi la riceve la trova nelle sue ricevute e fa sua la chiave. Fino ad allora nessuno può tirarne fuori niente.",

  "vaultDocs.section.relayer": "Il relayer",
  "vaultDocs.relayer.p1": "Una richiesta inviata dal tuo wallet mostra il tuo indirizzo. Per questo l'API del sito può inviare le tue richieste e le loro prove dal suo wallet, e pagare il gas: così il tuo indirizzo non compare in nessuna transazione.",
  "vaultDocs.relayer.p2": "Non scopre niente che la chain non mostri. La chiave gli arriva cifrata per il caveau e legata ai termini della richiesta: non può leggerla, né cambiare un termine, né riusarla. Vede, come qualsiasi server web, l'IP da cui arriva una richiesta.",
  "vaultDocs.relayer.p3": "Può rifiutare, non barare. Ha dei limiti al giorno e al minuto; se è giù o dice di no, la pagina invia la richiesta dal tuo wallet, e ti avvisa che allora il tuo indirizzo si vede.",

  "vaultDocs.section.leaks": "Cosa è pubblico, cosa no",
  "vaultDocs.leaks.public": "Pubblico",
  "vaultDocs.leaks.hidden": "Mai pubblico",
  "vaultDocs.leaks.public1": "Chi ha sigillato quale NFT (il deposito è un trasferimento di NFT)",
  "vaultDocs.leaks.public2": "L'NFT dentro ogni scatola, il suo stato, il suo annuncio",
  "vaultDocs.leaks.public3": "Gli annunci e gli acquisti su Seaport, con il caveau come venditore",
  "vaultDocs.leaks.public4": "L'indirizzo verso cui esce un NFT o l'ETH di una vendita, e l'importo",
  "vaultDocs.leaks.public5": "Che è stata fatta una richiesta, su quale scatola, per cosa, e se è stata eseguita, rifiutata o mancata",
  "vaultDocs.leaks.public6": "I due indirizzi di un trasferimento o di una vendita privata",
  "vaultDocs.leaks.hidden1": "Chi detiene una scatola",
  "vaultDocs.leaks.hidden2": "La chiave della scatola",
  "vaultDocs.leaks.hidden3": "Il prezzo di una vendita privata, e se è andata in porto",
  "vaultDocs.leaks.hidden4": "Se un trasferimento ha spostato qualcosa",
  "vaultDocs.leaks.hidden5": "Chi ha chiesto un annuncio, un ritiro o un incasso, quando lo invia il relayer",
  "vaultDocs.leaks.p1": "In pratica: tira fuori le cose verso un indirizzo senza storia, lascia che il relayer invii le tue richieste, e sappi che i tempi possono ancora dare indizi (un «Prendi la chiave» subito dopo un trasferimento verso lo stesso indirizzo, per esempio).",

  "vaultDocs.section.testnet": "Sulla rete di prova",
  "vaultDocs.testnet.p1": "Il caveau gira su Sepolia, la rete di prova di Ethereum, con il vero Seaport 1.5. La sua commissione è del {fee}%. La collezione di prova si conia gratis dalla pagina del caveau; niente qui vale denaro.",
  "vaultDocs.testnet.c.vault": "Il caveau sigillato",
  "vaultDocs.testnet.c.nft": "La collezione di prova gratuita",
  "vaultDocs.testnet.c.seaport": "Seaport 1.5",

  "vaultDocs.section.more": "Per saperne di più",
  "vaultDocs.more.project": "Su DO NOT OPEN",
  "vaultDocs.more.project.v": "L'idea, la cifratura, di chi ti fidi.",
  "vaultDocs.more.design": "Le note di progetto",
  "vaultDocs.more.design.v": "Ogni flusso, ogni controllo, ogni fuga, per sviluppatori.",
  "vaultDocs.more.contract": "Il contratto",
  "vaultDocs.more.contract.v": "SealedVault.sol, open source.",

  "vaultDocs.foot": "Il caveau sigillato gira su una rete di prova. Niente qui vale ancora denaro.",
};
