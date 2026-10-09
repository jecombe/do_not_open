import type { ProjectKey } from "./en";

export const projectIt: Record<ProjectKey, string> = {
  "project.title": "DO NOT OPEN, la documentazione: proprietà riservata su una chain pubblica",
  "project.description": "Cos'è DO NOT OPEN: scatole sigillate su Ethereum il cui detentore e il cui contenuto restano cifrati, grazie all'FHE di Zama. Il caveau sigillato per qualsiasi NFT, il gioco di {supply} gatti, cosa resta segreto e di chi ti fidi.",
  "project.imageAlt": "Una scatola di cartone sigillata col timbro DO NOT OPEN",
  "project.homeAria": "DO NOT OPEN, home",
  "project.site": "Sito",
  "project.language": "Lingua",
  "project.contents": "Indice",
  "project.nav.home": "Home",
  "project.nav.vault": "Il caveau",
  "project.nav.game": "Il gioco",

  "project.h1": "Riservato di default",
  "project.lede": "DO NOT OPEN mette ciò che possiedi su Ethereum in scatole sigillate: tutti possono verificare che le regole siano rispettate, nessuno può vedere chi ha cosa. Questa pagina spiega l'idea, le due cose costruite sopra e cosa resta segreto.",
  "project.hero.vault": "La documentazione del caveau",
  "project.hero.game": "Il manuale del gioco",

  "project.section.what": "Cos'è DO NOT OPEN",
  "project.what.p1": "Su una blockchain pubblica tutto è allo scoperto: gli NFT di ogni wallet, ogni vendita, ogni saldo, per sempre. Chiunque può vedere cosa possiedi, seguirlo, dargli un prezzo e venirtelo a prendere.",
  "project.what.p2": "DO NOT OPEN è uno strato di riservatezza per questo. Le cose entrano in scatole il cui detentore, e a volte il contenuto, sono cifrati on-chain. La chain fa comunque rispettare ogni regola: una scatola si sposta solo se il suo detentore l'ha spostata, una vendita si chiude solo se è stata pagata. Semplicemente non dice mai chi.",
  "project.what.p3": "Due prodotti condividono quest'idea e la stessa base di contratti: il caveau sigillato, uno strumento serio per qualsiasi NFT, e il gioco, 10.000 scatole con un gatto in ognuna, dove la stessa cifratura viene messa al lavoro per divertimento.",

  "project.section.fhe": "Come una scatola resta sigillata",
  "project.fhe.p1": "La cifratura è l'FHE di Zama (cifratura completamente omomorfica). Uno smart contract può sommare, confrontare e scegliere tra valori cifrati senza mai leggerli: \"chi chiama è il detentore?\" riceve un sì o un no cifrato, e la scatola si sposta o no di conseguenza.",
  "project.fhe.p2": "Nessuno ha la chiave che leggerebbe tutto. Il servizio di gestione delle chiavi di Zama la divide tra più parti indipendenti, che decifrano un valore solo quando il contratto lo permette: al solo detentore, in privato, o a tutti quando le regole dicono che diventa pubblico (un gatto una volta aperta la sua scatola, una richiesta che è stata accettata).",
  "project.fhe.p3": "Ogni rivelazione richiede due passi: una richiesta on-chain, poi una prova firmata da quelle parti che chiunque può riportare. Per questo alcune azioni aspettano qualche secondo la loro prova.",

  "project.section.vault": "Il caveau sigillato",
  "project.vault.p1": "Metti qualsiasi NFT di una collezione ammessa in una scatola. Da quel momento nessuno sa chi possiede la scatola: né i marketplace, né i tracker, né noi. L'NFT resta visibile; il suo detentore no.",
  "project.vault.p2": "La scatola si può comunque vendere su Seaport, il protocollo di OpenSea, con il caveau come venditore, o in privato a un solo acquirente a un prezzo che solo loro due possono leggere. L'NFT, o l'ETH di una vendita, esce verso qualsiasi indirizzo, e un relayer può inviare le richieste perché l'indirizzo del detentore non compaia da nessuna parte.",
  "project.vault.p3": "Il caveau custodisce anche token. I tuoi cUSDC, un dollaro confidenziale, vanno in una tasca chiusa da una chiave invece che da un indirizzo: mandali a un'altra tasca, paga una scatola, o ritirali dove vuoi. I token confidenziali nascondono già gli importi; una tasca nasconde anche chi ha pagato chi.",
  "project.vault.docs": "Leggi la documentazione del caveau",
  "project.vault.open": "Apri il caveau",

  "project.section.game": "Il gioco",
  "project.game.p1": "{supply} scatole sigillate, un gatto in ognuna, scelto a caso e cifrato nel momento in cui la scatola viene creata. Scuoti una scatola per avere un indizio privato, aprila per mostrare il gatto a tutti, sfidala a duello, dagli le crocchette, scambiala al mercatino.",
  "project.game.p2": "Chi possiede quale scatola, quante ne sono state vendute e cosa c'è dentro restano tutti cifrati, con la stessa base di contratti del caveau. Il gioco è dove la tecnologia viene messa al lavoro su larga scala, e dove vive la community fino alla mainnet.",
  "project.game.docs": "Leggi il manuale del gioco",
  "project.game.open": "Gioca",

  "project.section.leaks": "Cosa resta segreto, cosa no",
  "project.leaks.p1": "La cifratura nasconde i valori, non il fatto che qualcosa sia successo. Una transazione è pubblica: chi l'ha inviata, a quale contratto, quando. Quello che DO NOT OPEN cifra è ciò che la transazione fa: chi finisce per possedere una scatola, un prezzo concordato in privato, se un trasferimento ha spostato qualcosa.",
  "project.leaks.p2": "Alcune cose sono pubbliche di proposito. Un NFT che entra nel caveau è un semplice trasferimento di NFT, quindi chi lo deposita si vede. Un annuncio su Seaport mostra il suo NFT e il suo prezzo, con il caveau come venditore. Anche l'indirizzo verso cui esce un NFT o l'ETH di una vendita si vede: scegline uno senza storia.",
  "project.leaks.p3": "Ogni prodotto elenca esattamente cosa trapela, riga per riga, nella sua documentazione.",

  "project.section.trust": "Di chi ti devi fidare",
  "project.trust.p1": "Dei contratti: il loro codice è open source, e decidono tutto loro. Nessuno, noi compresi, può spostare una scatola, leggere un detentore o cambiare una vendita passata.",
  "project.trust.p2": "Del servizio di gestione delle chiavi di Zama, per cosa viene decifrato e per chi: le sue parti dovrebbero mettersi d'accordo per leggere ciò che i contratti non hanno permesso. E del relayer del caveau, per niente: non può leggere una richiesta né modificarla, solo rifiutarsi di inviarla, e allora la invia il tuo wallet.",
  "project.trust.p3": "Il proprietario dei contratti può ammettere una collezione nel caveau e fissarne la commissione, entro un tetto scritto nel contratto (10%). Non può toccare una scatola. Prima della mainnet, questa proprietà passa a un multisig.",

  "project.section.status": "A che punto siamo",
  "project.status.p1": "Tutto gira su Sepolia, la rete di prova di Ethereum: NFT di prova, ETH di prova, niente che contenga denaro. Il gioco è attivo lì con la sua community; il caveau da ottobre 2026.",
  "project.status.p2": "La mainnet arriva quando i contratti saranno stati revisionati. La whitelist del gioco e i suoi regali passano alla mainnet; il caveau si apre alle collezioni vere.",

  "project.section.more": "Per saperne di più",
  "project.more.vault": "La documentazione del caveau",
  "project.more.vault.v": "Il deposito, la chiave, Seaport, le vendite private, le tasche, il relayer, cosa trapela.",
  "project.more.game": "Il manuale del gioco",
  "project.more.game.v": "Scatole, gatti, crocchette, ratti, il mercatino, la testnet.",
  "project.more.repo": "Il codice",
  "project.more.repo.v": "I contratti del gioco e del caveau, i loro test e i loro indirizzi, open source su GitLab.",
  "project.more.zama": "L'FHEVM di Zama",
  "project.more.zama.v": "La cifratura su cui girano i contratti.",

  "project.foot": "DO NOT OPEN gira su una rete di prova. Niente qui vale ancora denaro.",
};
