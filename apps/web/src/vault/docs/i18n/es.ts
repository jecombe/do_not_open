import type { VaultDocsKey } from "./en";

export const vaultDocsEs: Record<VaultDocsKey, string> = {
  "vaultDocs.title": "La bóveda sellada, la documentación · DO NOT OPEN",
  "vaultDocs.description": "Cómo funciona la bóveda sellada: un NFT en una caja cuyo titular está cifrado, una llave que nadie puede leer, anuncios en Seaport con la bóveda como vendedora, ventas privadas a un precio secreto, un relayer, y exactamente lo que se filtra.",
  "vaultDocs.imageAlt": "Una caja de cartón sellada con el sello DO NOT OPEN, con un NFT dentro",
  "vaultDocs.homeAria": "DO NOT OPEN, inicio",
  "vaultDocs.site": "Sitio",
  "vaultDocs.language": "Idioma",
  "vaultDocs.contents": "Contenido",
  "vaultDocs.nav.home": "Inicio",
  "vaultDocs.nav.vault": "Abrir la bóveda",

  "vaultDocs.h1": "La bóveda sellada",
  "vaultDocs.lede": "Cualquier NFT en una caja cuyo titular está cifrado on-chain. Aun así se puede vender en Seaport, o en privado por un precio que solo lee el comprador, y sale a cualquier dirección. Así funciona, y esto es lo que cualquiera puede seguir viendo.",
  "vaultDocs.hero.open": "Abrir la bóveda",
  "vaultDocs.hero.leaks": "Lo que se filtra",

  "vaultDocs.section.what": "Qué es la bóveda",
  "vaultDocs.what.p1": "Un contrato que guarda NFT. Cada NFT que entra recibe una caja: un token propio cuyo titular está cifrado, como las cajas del juego. El NFT se queda dentro hasta que el titular de la caja lo saca, lo vende en Seaport o vende la caja en privado.",
  "vaultDocs.what.p2": "La bóveda acepta las colecciones que permite su propietario. En la red de prueba es una colección de prueba gratuita que cualquiera puede mintear.",

  "vaultDocs.section.seal": "Sellar un NFT",
  "vaultDocs.seal.p1": "Sellar es una sola transacción: el NFT entra en la bóveda y se crea una caja para él, que tienes tú. Es pública, porque es una simple transferencia de NFT: todos ven quién selló qué NFT. Lo que le pase a la caja después, no.",
  "vaultDocs.seal.p2": "El depósito nombra a su depositante, pero también puede enviar enseguida la nueva caja, en la misma transacción, a unas cuantas direcciones al azar donde cada transferencia no mueve nada (señuelos, marcados por defecto). Todo el mundo ve las transferencias, nadie ve cuál movió la caja: ni siquiera el depositante es ya su titular evidente. Sin señuelos, lo es mientras la caja no se mueva.",
  "vaultDocs.seal.p3": "Para volver a encontrar tus cajas, la página lee tus propios recibos y descifra, solo para ti, cuáles te llegaron de verdad. Una firma.",

  "vaultDocs.section.key": "La llave de la caja",
  "vaultDocs.key.p1": "Cada caja tiene una llave: un secreto de 256 bits, guardado cifrado, que nadie puede leer, ni siquiera tú. La bóveda solo la compara. Todo lo que sale de la bóveda (el NFT, un anuncio, el ETH de una venta) se pide con la llave, nunca con tu dirección.",
  "vaultDocs.key.p2": "Nunca escribes la llave. Tu wallet firma un mensaje fijo, gratis, y la página deriva de esa firma la llave de cada caja: el mismo wallet genera las mismas llaves en cualquier dispositivo. Firma ese mensaje solo en DO NOT OPEN: quien consiga la firma puede sacar tus NFT.",
  "vaultDocs.key.p3": "Una llave nunca se envía tal cual: se mezcla con los términos exactos de la solicitud (la caja, la acción, la dirección, el precio, la fecha de fin y un contador). Cambia un término, o envía la misma solicitud otra vez más tarde, y la llave deja de coincidir: la solicitud se rechaza.",
  "vaultDocs.key.p4": "Una caja que cambia de manos recibe una llave aleatoria, así que su titular anterior ya no puede hacer nada con ella. Su nuevo titular hace suya la llave con una transacción («Quedarme la llave»). Cualquiera puede intentarlo, pero solo surte efecto para el titular, y desde fuera las dos cosas se ven iguales.",

  "vaultDocs.section.requests": "Pedir algo",
  "vaultDocs.requests.p1": "Sacar un NFT, ponerlo en venta, retirar un anuncio y cobrar el ETH de una venta funcionan igual, en dos pasos. Una solicitud on-chain: la bóveda comprueba la llave bajo cifrado. Luego una prueba del servicio de gestión de llaves de Zama de que la llave coincidió, que cualquiera puede traer de vuelta.",
  "vaultDocs.requests.p2": "La solicitud se resuelve de una de cuatro maneras: hecha; rechazada, cuando la llave no coincidió (no pasa nada, nada revierte, así que un desconocido no aprende nada); fallida, cuando la caja cambió entretanto (vendida en Seaport mientras tanto, por ejemplo); o expirada, cuando no llegó ninguna prueba en un día (no pasa nada).",
  "vaultDocs.requests.p3": "Las solicitudes no se bloquean entre sí: un desconocido que envía solicitudes con una llave equivocada no puede impedirte sacar tu NFT, ponerlo en venta o cobrar. Cada una se decide por separado, y el contador que se mezcla con la llave solo avanza cuando una llave coincidió: el intento de un desconocido no estropea nada de lo que preparaste. Mientras una solicitud espera su prueba, la caja no puede cambiar de manos; la página resuelve primero las que esperan (cualquiera puede), y una cuya prueba nunca llega puede expirarla cualquiera al cabo de un día. Ninguna caja se queda bloqueada.",

  "vaultDocs.section.seaport": "Vender en Seaport",
  "vaultDocs.seaport.p1": "Un anuncio es una orden real de Seaport 1.5, el protocolo de OpenSea, cuyo vendedor es la propia bóveda: tu dirección no aparece en ninguna parte. La bóveda valida la orden on-chain, así que no firma nada, y solo las órdenes que ella validó pueden vender sus NFT.",
  "vaultDocs.seaport.p2": "Cualquier marketplace de Seaport puede completarla. El comprador paga en ETH y recibe el NFT al instante. Los compradores ven el NFT, el precio y la fecha de fin, como en cualquier anuncio.",
  "vaultDocs.seaport.p3": "El ETH espera en la caja a quien tenga la llave, menos la comisión de la bóveda ({fee}%, nunca más del {max}%). Lo cobras en cualquier dirección. Un anuncio dura hasta 180 días; uno que caducó sin comprador vuelve a quedar sellado.",

  "vaultDocs.section.private": "Ventas privadas",
  "vaultDocs.private.p1": "Ofrece una caja a un solo comprador, por un precio en cUSDC (un dólar confidencial) que solo vosotros dos podéis leer. El comprador lo lee en la página, y luego paga y se lleva la caja en una sola transacción.",
  "vaultDocs.private.p2": "Todo se resuelve bajo cifrado: si el precio llegó y el vendedor aún tenía la caja, la caja se mueve con una llave que es del comprador, y el vendedor cobra; si no, nada se mueve y el comprador recupera sus cUSDC. Para todos los demás, una venta que se hizo y una que no se ven iguales.",
  "vaultDocs.private.p3": "Cualquiera puede ofrecer cualquier caja, así que una oferta no demuestra nada sobre quién la tiene. El vendedor puede cancelar una oferta abierta; solo el comprador nombrado puede aceptarla, una vez.",

  "vaultDocs.section.give": "Regalar una caja",
  "vaultDocs.give.p1": "Envía una caja a cualquier dirección. Solo se mueve si la tienes, y llega sin llave: quien la recibe la encuentra en sus recibos y hace suya la llave. Hasta entonces nadie puede sacar nada de ella.",

  "vaultDocs.section.relayer": "El relayer",
  "vaultDocs.relayer.p1": "Una solicitud enviada desde tu wallet muestra tu dirección. Por eso la API del sitio puede enviar tus solicitudes y sus pruebas desde su propio wallet, y pagar el gas: así tu dirección no aparece en ninguna transacción.",
  "vaultDocs.relayer.p2": "No aprende nada que la cadena no muestre. La llave le llega cifrada para la bóveda y atada a los términos de la solicitud: no puede leerla, ni cambiar un término, ni reutilizarla. Ve, como cualquier servidor web, la IP de la que viene una solicitud.",
  "vaultDocs.relayer.p3": "Puede negarse, no hacer trampa. Tiene límites por día y por minuto; si está caído o dice que no, la página envía la solicitud desde tu wallet, y te avisa de que entonces se ve tu dirección.",

  "vaultDocs.section.leaks": "Lo que es público y lo que no",
  "vaultDocs.leaks.public": "Público",
  "vaultDocs.leaks.hidden": "Nunca público",
  "vaultDocs.leaks.public1": "Quién selló qué NFT (el depósito es una transferencia de NFT), y las direcciones adonde fueron sus señuelos",
  "vaultDocs.leaks.public2": "El NFT dentro de cada caja, su estado, su anuncio",
  "vaultDocs.leaks.public3": "Los anuncios y las compras en Seaport, con la bóveda como vendedora",
  "vaultDocs.leaks.public4": "La dirección a la que sale un NFT o el ETH de una venta, y el importe",
  "vaultDocs.leaks.public5": "Que se hizo una solicitud, sobre qué caja, para qué, y si se hizo, se rechazó, falló o expiró",
  "vaultDocs.leaks.public6": "Las dos direcciones de una transferencia o de una venta privada",
  "vaultDocs.leaks.hidden1": "Quién tiene una caja",
  "vaultDocs.leaks.hidden2": "La llave de la caja",
  "vaultDocs.leaks.hidden3": "El precio de una venta privada, y si se hizo",
  "vaultDocs.leaks.hidden4": "Si una transferencia movió algo",
  "vaultDocs.leaks.hidden5": "Quién pidió un anuncio, una retirada o un cobro, cuando lo envía el relayer",
  "vaultDocs.leaks.p1": "En la práctica: saca las cosas a una dirección sin historial, deja que el relayer envíe tus solicitudes, y ten en cuenta que los tiempos aún pueden dar pistas (un «Quedarme la llave» justo después de una transferencia a la misma dirección, por ejemplo).",

  "vaultDocs.section.testnet": "En la red de prueba",
  "vaultDocs.testnet.p1": "La bóveda funciona en Sepolia, la red de prueba de Ethereum, con el Seaport 1.5 real. Su comisión es del {fee}%. La colección de prueba se mintea gratis desde la página de la bóveda; nada de esto vale dinero.",
  "vaultDocs.testnet.c.vault": "La bóveda sellada",
  "vaultDocs.testnet.c.nft": "La colección de prueba gratuita",
  "vaultDocs.testnet.c.seaport": "Seaport 1.5",

  "vaultDocs.section.more": "Para saber más",
  "vaultDocs.more.project": "Sobre DO NOT OPEN",
  "vaultDocs.more.project.v": "La idea, el cifrado, en quién confías.",
  "vaultDocs.more.design": "Las notas de diseño",
  "vaultDocs.more.design.v": "Cada flujo, cada comprobación, cada filtración, para desarrolladores.",
  "vaultDocs.more.contract": "El contrato",
  "vaultDocs.more.contract.v": "SealedVault.sol, de código abierto.",

  "vaultDocs.foot": "La bóveda sellada funciona en una red de prueba. Nada de esto vale dinero todavía.",
};
