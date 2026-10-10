# X

The X (Twitter) account's pictures, in two versions: **v1**, half the game and half the vault, and
**v2**, the sealed vault first with the game as a nod (the one in use).

| File | Where it goes |
| --- | --- |
| `avatar-v2.png` | The profile picture, 1000×1000: the sealed box (kraft with the vault's teal edges, a padlock on its tape, stamped DO NOT OPEN) with a cat's eyes behind its lid, inside the shield. X crops it to a circle, so everything stays inside it. The same drawing is the Discord server's icon and the GitLab group's avatar |
| `banner-v2.png` | The header, 1500×500 (`banner-v2@2x.png` at 3000×1000): "What you own is nobody's business.", the sealed box taking in an NFT, cUSDC, cWETH, cUSDT, cZAMA and a Uniswap position, a probe refused at the shield, and the game as a line at the bottom. The avatar sits over the bottom left and phones crop the top and bottom, so both stay plain |
| `avatar-v1.png`, `banner-v1.png`, `banner-v1@2x.png` | The first ones: the box half cardboard (the game), half cipher (the vault); the banner's warehouse and cats on the left, "The world sees the art. Not the owner." on the right |

Sources are the `.html` files next to them, SVG in the site's palette and fonts (loaded from
`node_modules`, so run `pnpm install` first); v2 uses the site's token glyphs and protocol logos
(`apps/web/src/brand`) and the `dno_tuxedo` emoji from `../discord/emoji`. Render again with Chrome headless:

```bash
google-chrome --headless=new --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=2.5 --window-size=400,400 --screenshot=avatar-v2.png "file://$PWD/avatar-v2.html"
google-chrome --headless=new --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=2 --window-size=1500,500 --screenshot=banner-v2@2x.png "file://$PWD/banner-v2.html"
```
