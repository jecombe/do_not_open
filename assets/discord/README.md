# Discord

Pictures for the collection's Discord server. The server icon and the bot's banner come in two versions:
**v1**, half the game and half the vault, and **v2**, the sealed vault first with the game as a nod (the one in use).

| File | Where it goes |
| --- | --- |
| `herald.png` | The webhook that posts the herald's announcements (channel settings, Integrations, Webhooks): a Maine Coon in a golden crown, seed `0x1c4530fcbaf41ea7`, affection 11 |
| `clerk.png` | The application behind `/ask` (Developer Portal, App Icon, and the Bot's avatar) |
| `server-v2.png` | The server icon (Server Settings, Overview), 1024×1024: the X profile picture's drawing (`avatar-v2`), the sealed box (kraft with the vault's teal edges, a padlock on its tape) with a cat's eyes behind its lid. `server-v1.png` is the first one: the DO NOT OPEN stamp half on cardboard (the game), half in cipher (the vault) |
| `banner-v2.png` | The bot's profile banner (Developer Portal, Bot, Banner), 680×240 drawn at 2×: the sealed vault first ("What you own is nobody's business.", the /ask stamp, the box taking in an NFT and confidential tokens), the game as a line at the bottom; the bottom left stays plain under the avatar; `banner-v2-680.png` is the same at 680×240. `banner-v1.png` and `banner-v1-680.png` are the first one: the warehouse's shelves, the DO NOT OPEN sign and the /ask stamp |
| `channel.png` | An older server icon: the DO NOT OPEN stamp on a box lid |
| `emoji/*.png`, `emoji/*.gif` | Server emoji (Server Settings, Emoji), 128×128, under Discord's 256 KB |

`herald.png` and every cat and box in `emoji/` are stills of the game's own three.js builders
(`createCat`, `createBox`, `BoxShaker` from `@dno/scene`), drawn on a transparent background from
real seeds and cropped square; the GIFs are 24 to 30 frames of the same animations. `clerk.png`,
`channel.png` and `emoji/dno_stamp.png` are SVG drawings in the game's palette and fonts, sources
in `clerk.html` and `channel.html` (open in Chrome headless at 1024×1024 to render again); each version's server icon in
`server-v1.html` / `server-v2.html` (400×400, rendered at a scale of 2.56) and its banner in `banner-v1.html` / `banner-v2.html` (1360×480, at 1 and 0.5); v2 is
built from the site's token glyphs and protocol logos (`apps/web/src/brand`) and the `dno_tuxedo` emoji.

The emoji seeds, all alive unless named after a state:

| Emoji | Seed |
| --- | --- |
| `dno_tabby` | `0x8218562bc51c053e` |
| `dno_tuxedo` | `0x1ff2ea9971411e67` |
| `dno_orange` | `0x0c0f5c2780700257` |
| `dno_calico` | `0xe4d5bf2aa6964da3` |
| `dno_siamese` | `0x1310c7b988b1623c` |
| `dno_void` | `0x6e403e3c71d0b2bc` |
| `dno_sphynx` | `0x55b44fedf5ea9410` |
| `dno_mainecoon` | `0x7b7b0a2facef1e57` |
| `dno_loaf` | `0x5f644c1854f951e1` |
| `dno_glitch` | `0xc89c8f1baefe77bb` |
| `dno_wizard` | `0x37e947f292762a21` |
| `dno_party` | `0x690975da96aa7cfa` |
| `dno_ghost` | `0x0edea877e337e722` |
| `dno_asleep` | `0x48c94e897576e08e` |
| `dno_quantum` | `0x4d2d251b88b8fefe` |
| `dno_king` | `0x1c4530fcbaf41ea7` (affection 11: golden crown) |
| `dno_box`, `dno_shake` | token 7 |
