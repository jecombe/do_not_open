import type { ProjectKey } from "./en";

export const projectEs: Record<ProjectKey, string> = {
  "project.title": "DO NOT OPEN, la documentación: propiedad confidencial en una cadena pública",
  "project.description": "Qué es DO NOT OPEN: cajas selladas en Ethereum cuyo titular y contenido siguen cifrados, gracias al FHE de Zama. La bóveda sellada para cualquier NFT, el juego de {supply} gatos, lo que queda en secreto y en quién confías.",
  "project.imageAlt": "Una caja de cartón sellada con el sello DO NOT OPEN",
  "project.homeAria": "DO NOT OPEN, inicio",
  "project.site": "Sitio",
  "project.language": "Idioma",
  "project.contents": "Contenido",
  "project.nav.home": "Inicio",
  "project.nav.vault": "La bóveda",
  "project.nav.game": "El juego",

  "project.h1": "Confidencial por defecto",
  "project.lede": "DO NOT OPEN mete lo que tienes en Ethereum en cajas selladas: todos pueden comprobar que se cumplen las reglas, nadie puede ver quién tiene qué. Esta página explica la idea, las dos cosas construidas sobre ella y lo que queda en secreto.",
  "project.hero.vault": "La documentación de la bóveda",
  "project.hero.game": "El manual del juego",

  "project.section.what": "Qué es DO NOT OPEN",
  "project.what.p1": "En una blockchain pública todo está a la vista: los NFT de cada wallet, cada venta, cada saldo, para siempre. Cualquiera puede ver lo que tienes, seguirlo, ponerle precio e ir a por ello.",
  "project.what.p2": "DO NOT OPEN es una capa de confidencialidad para eso. Las cosas entran en cajas cuyo titular, y a veces su contenido, están cifrados on-chain. La cadena sigue haciendo cumplir cada regla: una caja solo se mueve si su titular la movió, una venta solo se cierra si se pagó. Simplemente nunca dice quién.",
  "project.what.p3": "Dos productos comparten esa idea y la misma base de contratos: la bóveda sellada, una herramienta seria para cualquier NFT, y el juego, 10.000 cajas con un gato en cada una, donde el mismo cifrado se pone a trabajar por diversión.",

  "project.section.fhe": "Cómo se mantiene sellada una caja",
  "project.fhe.p1": "El cifrado es el FHE de Zama (cifrado totalmente homomórfico). Un contrato inteligente puede sumar, comparar y elegir entre valores cifrados sin leerlos nunca: \"¿es este llamante el titular?\" recibe un sí o un no cifrado, y la caja se mueve o no según la respuesta.",
  "project.fhe.p2": "Nadie tiene la llave que lo leería todo. El servicio de gestión de llaves de Zama la reparte entre varias partes independientes, que descifran un valor solo cuando el contrato lo permite: solo para su titular, en privado, o para todos cuando las reglas dicen que se hace público (un gato una vez abierta su caja, una solicitud que fue aceptada).",
  "project.fhe.p3": "Cada revelación tiene dos pasos: una solicitud on-chain, y luego una prueba firmada por esas partes que cualquiera puede traer de vuelta. Por eso algunas acciones esperan unos segundos a su prueba.",

  "project.section.vault": "La bóveda sellada",
  "project.vault.p1": "Mete cualquier NFT de una colección permitida en una caja. Desde ese momento nadie sabe quién tiene la caja: ni los marketplaces, ni los rastreadores, ni nosotros. El NFT sigue a la vista; su titular no.",
  "project.vault.p2": "La caja se puede seguir vendiendo en Seaport, el protocolo de OpenSea, con la bóveda como vendedora, o en privado a un solo comprador por un precio que solo ellos dos pueden leer. El NFT, o el ETH de una venta, sale a cualquier dirección, y un relayer puede enviar las solicitudes para que la dirección del titular no aparezca en ninguna parte.",
  "project.vault.p3": "La bóveda guarda también tokens. Tus cUSDC, un dólar confidencial, van a un bolsillo cerrado por una llave en lugar de una dirección: envíalos a otro bolsillo, paga una caja con ellos o sácalos a donde quieras. Los tokens confidenciales ya ocultan los importes; un bolsillo oculta además quién pagó a quién. cUSDT, cWETH y cZAMA, los otros tokens confidenciales de Zama, tienen sus propios bolsillos; las cajas se pagan en cUSDC.",
  "project.vault.docs": "Leer la documentación de la bóveda",
  "project.vault.open": "Abrir la bóveda",

  "project.section.game": "El juego",
  "project.game.p1": "{supply} cajas selladas, un gato en cada una, elegido al azar y cifrado en el momento en que se crea la caja. Agita una caja para obtener una pista privada, ábrela para mostrar el gato a todos, haz duelos, dale croquetas, véndela en el mercadillo.",
  "project.game.p2": "Quién tiene cada caja, cuántas se vendieron y qué hay dentro siguen cifrados, con la misma base de contratos que la bóveda. El juego es donde la tecnología se pone a trabajar a gran escala, y donde vive la comunidad hasta la mainnet.",
  "project.game.docs": "Leer el manual del juego",
  "project.game.open": "Jugar",

  "project.section.leaks": "Lo que queda en secreto, lo que no",
  "project.leaks.p1": "El cifrado oculta valores, no el hecho de que algo ocurrió. Una transacción es pública: quién la envió, a qué contrato, cuándo. Lo que DO NOT OPEN cifra es lo que hace la transacción: quién acaba teniendo una caja, un precio acordado en privado, si una transferencia movió algo.",
  "project.leaks.p2": "Algunas cosas son públicas a propósito. Un NFT que entra en la bóveda es una simple transferencia de NFT, así que el depositante se ve. Un anuncio de Seaport muestra su NFT y su precio, con la bóveda como vendedora. La dirección a la que sale un NFT o el ETH de una venta también se ve: elige una sin historial.",
  "project.leaks.p3": "Cada producto detalla exactamente lo que se filtra, línea por línea, en su propia documentación.",

  "project.section.trust": "En quién tienes que confiar",
  "project.trust.p1": "En los contratos: su código es abierto, y ellos lo deciden todo. Nadie, nosotros incluidos, puede mover una caja, leer un titular o cambiar una venta pasada.",
  "project.trust.p2": "En el servicio de gestión de llaves de Zama, para lo que se descifra y para quién: sus partes tendrían que ponerse de acuerdo para leer lo que los contratos no permitieron. Y en el relayer de la bóveda, en nada: no puede leer una solicitud ni cambiarla, solo negarse a enviarla, y entonces la envía tu wallet.",
  "project.trust.p3": "El propietario de los contratos puede permitir una colección en la bóveda y fijar su comisión, dentro de un tope escrito en el contrato (10%). No puede tocar una caja. Antes de la mainnet, esa propiedad pasa a una multisig.",

  "project.section.status": "Dónde estamos",
  "project.status.p1": "Todo funciona en Sepolia, la red de prueba de Ethereum: NFT de prueba, ETH de prueba, nada con dinero dentro. El juego está activo allí con su comunidad; la bóveda, desde octubre de 2026.",
  "project.status.p2": "La mainnet llega cuando los contratos hayan sido revisados. La whitelist del juego y sus regalos se mantienen; la bóveda se abre a colecciones reales.",

  "project.section.more": "Para saber más",
  "project.more.vault": "La documentación de la bóveda",
  "project.more.vault.v": "El depósito, la llave, Seaport, las ventas privadas, los bolsillos, el relayer, lo que se filtra.",
  "project.more.game": "El manual del juego",
  "project.more.game.v": "Cajas, gatos, croquetas, ratas, el mercadillo, la testnet.",
  "project.more.repo": "El código",
  "project.more.repo.v": "Los contratos del juego y de la bóveda, sus pruebas y sus direcciones, de código abierto en GitLab.",
  "project.more.zama": "El FHEVM de Zama",
  "project.more.zama.v": "El cifrado sobre el que funcionan los contratos.",

  "project.foot": "DO NOT OPEN funciona en una red de prueba. Nada de esto vale dinero todavía.",
};
