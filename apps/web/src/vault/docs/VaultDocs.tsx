import { useEffect, type ReactNode } from "react";
import { DocShell, Prose } from "../../docs/DocShell";
import { FlowFigure } from "../../docs/figures";
import { useLocale } from "../../i18n/locale";
import { BrandIcon } from "../../brand/logos";
import { REPO, SOURCE, SOURCE_VAULT } from "../../links";
import { homePath, projectDocsPath, vaultPath } from "../../site";
import { useT } from "./i18n";

const SECTIONS = ["what", "seal", "key", "requests", "seaport", "offers", "bid", "private", "pockets", "liquidity", "give", "delegate", "relayer", "leaks", "testnet", "more"] as const;

// The vault's fee is a deployment setting (VAULT_FEE_BPS, 250 by default), capped by
// SealedVault's MAX_FEE_BPS (1,000): it is not in the game's spec.
const FEE = { fee: 2.5, max: 10 };
// The positions' share of the trading fees they collect (POSITIONS_FEE_BPS, 500 by default),
// capped by SealedPositions' MAX_FEE_BPS (1,000).
const LP_FEE = { lpFee: 5, max: 10 };

const EXPLORER = "https://sepolia.etherscan.io/address/";

/** The vault's contracts on Sepolia, as `dno:export` last wrote them. */
const CONTRACTS = [
  { key: "vault", address: "0xE22509e741233072aFF4e0c6B56d5e3De8018262" },
  { key: "nft", address: "0xf72Eb38f816B1B8Effa8B6036C0BA6A38D6d6f9b" },
  { key: "seaport", address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC" },
  { key: "offers", address: "0x750d5B8E8A0f55b8E1F74bA3387B59cc8080f9E2" },
  { key: "weth", address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" },
  { key: "registry", address: "0x00000000000000447e69651d841bD8D104Bed493" },
  { key: "pockets", address: "0x220635318dDe0517E835D9FdF80AFEaD52720B7C" },
  { key: "desk", address: "0xd17cB7696236B14C28f51Ef03BEBd133710e4A5f" },
  { key: "pocketsUsdt", address: "0x0824f7CF1d3B258d059808cfA7cc3B8FBE1aD9FE" },
  { key: "pocketsWeth", address: "0x4b771718d45F0FD0fc56bbe54099d1fBCb2A85b0" },
  { key: "pocketsZama", address: "0x3a294c75f0bf35b06B60f664425F820c801F6158" },
  { key: "positions", address: "0x118081c2Cf2719cBe624a818C2ae50961A92aC53" },
  { key: "poolWeth", address: "0x061917a4Aa293bC74fE8d9c5341FE7b5E4275285" },
  { key: "poolZama", address: "0x821E98fAfDB88C16F558A2DC6f45E9A74Dd76D78" },
] as const;

/** The manual's animated flow of a withdrawal through the relayer. */
const VAULT_FLOW = ["vault"] as const;

const PUBLIC = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] as const;
const HIDDEN = ["1", "2", "3", "4", "5", "6", "7"] as const;

/**
 * The sealed vault's documentation, at `/docs` on `vault.`: for holders and buyers, no code.
 * Developers have docs/VAULT.md, which this follows.
 */
export function VaultDocs() {
  const t = useT();
  const locale = useLocale();

  useEffect(() => {
    document.title = t("vaultDocs.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("vaultDocs.description"));
  }, [t]);

  const refs = [
    { key: "project", href: projectDocsPath(locale) },
    { key: "design", href: `${REPO}/blob/dev/docs/VAULT.md` },
    { key: "code", href: SOURCE_VAULT },
    { key: "contract", href: `${SOURCE_VAULT}/-/blob/main/contracts/SealedVault.sol` },
  ] as const;

  const body: Record<(typeof SECTIONS)[number], ReactNode> = {
    what: <Prose>{[t("vaultDocs.what.p1"), t("vaultDocs.what.p2"), t("vaultDocs.what.p3")]}</Prose>,
    seal: <Prose>{[t("vaultDocs.seal.p1"), t("vaultDocs.seal.p2"), t("vaultDocs.seal.p3")]}</Prose>,
    key: <Prose>{[t("vaultDocs.key.p1"), t("vaultDocs.key.p2"), t("vaultDocs.key.p3"), t("vaultDocs.key.p4")]}</Prose>,
    requests: (
      <>
        <Prose>{[t("vaultDocs.requests.p1"), t("vaultDocs.requests.p2"), t("vaultDocs.requests.p3"), t("vaultDocs.requests.p4")]}</Prose>
        <FlowFigure keys={VAULT_FLOW} />
      </>
    ),
    seaport: <Prose>{[t("vaultDocs.seaport.p1"), t("vaultDocs.seaport.p2"), t("vaultDocs.seaport.p3", FEE)]}</Prose>,
    offers: (
      <Prose>
        {[t("vaultDocs.offers.p1"), t("vaultDocs.offers.p2", FEE), t("vaultDocs.offers.p3"), t("vaultDocs.offers.p4"), t("vaultDocs.offers.p5")]}
      </Prose>
    ),
    bid: <Prose>{[t("vaultDocs.bid.p1"), t("vaultDocs.bid.p2"), t("vaultDocs.bid.p3")]}</Prose>,
    private: <Prose>{[t("vaultDocs.private.p1"), t("vaultDocs.private.p2"), t("vaultDocs.private.p3")]}</Prose>,
    pockets: (
      <Prose>
        {[t("vaultDocs.pockets.p1"), t("vaultDocs.pockets.p2"), t("vaultDocs.pockets.p3"), t("vaultDocs.pockets.p4"), t("vaultDocs.pockets.p5"), t("vaultDocs.pockets.p6"), t("vaultDocs.pockets.p7"), t("vaultDocs.pockets.p8")]}
      </Prose>
    ),
    liquidity: (
      <Prose>
        {[t("vaultDocs.liquidity.p1"), t("vaultDocs.liquidity.p2"), t("vaultDocs.liquidity.p3"), t("vaultDocs.liquidity.p4", LP_FEE), t("vaultDocs.liquidity.p5"), t("vaultDocs.liquidity.p6")]}
      </Prose>
    ),
    give: <Prose>{[t("vaultDocs.give.p1")]}</Prose>,
    delegate: <Prose>{[t("vaultDocs.delegate.p1"), t("vaultDocs.delegate.p2"), t("vaultDocs.delegate.p3")]}</Prose>,
    relayer: <Prose>{[t("vaultDocs.relayer.p1"), t("vaultDocs.relayer.p2"), t("vaultDocs.relayer.p3")]}</Prose>,
    leaks: (
      <>
        <div className="doc-leaks">
          <div>
            <h3>{t("vaultDocs.leaks.public")}</h3>
            <ul>
              {PUBLIC.map((n) => (
                <li key={n}>{t(`vaultDocs.leaks.public${n}`)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3>{t("vaultDocs.leaks.hidden")}</h3>
            <ul>
              {HIDDEN.map((n) => (
                <li key={n}>{t(`vaultDocs.leaks.hidden${n}`)}</li>
              ))}
            </ul>
          </div>
        </div>
        <Prose>{[t("vaultDocs.leaks.p1")]}</Prose>
      </>
    ),
    testnet: (
      <>
        <Prose>{[t("vaultDocs.testnet.p1", FEE), t("vaultDocs.testnet.p2")]}</Prose>
        <ul className="addresses">
          {CONTRACTS.map((c) => (
            <li key={c.key}>
              <span>{t(`vaultDocs.testnet.c.${c.key}`)}</span>
              <a href={`${EXPLORER}${c.address}`}>
                {c.address.slice(0, 6)}…{c.address.slice(-4)}
              </a>
            </li>
          ))}
        </ul>
      </>
    ),
    more: (
      <ul className="refs">
        {refs.map((r) => (
          <li key={r.key}>
            <a href={r.href} className={r.href.startsWith(SOURCE) ? "with-logo" : undefined}>
              {r.href.startsWith(SOURCE) && <BrandIcon brand="gitlab" size={16} />}
              {t(`vaultDocs.more.${r.key}`)}
            </a>
            <span>{t(`vaultDocs.more.${r.key}.v`)}</span>
          </li>
        ))}
      </ul>
    ),
  };

  return (
    <DocShell
      home={homePath(locale)}
      homeAria={t("vaultDocs.homeAria")}
      navLabel={t("vaultDocs.site")}
      languageLabel={t("vaultDocs.language")}
      contentsLabel={t("vaultDocs.contents")}
      nav={[
        { href: homePath(locale), label: t("vaultDocs.nav.home") },
        { href: vaultPath(locale), label: t("vaultDocs.nav.vault") },
      ]}
      title={t("vaultDocs.h1")}
      lede={t("vaultDocs.lede")}
      heroLinks={[
        { href: vaultPath(locale), label: t("vaultDocs.hero.open") },
        { href: "#leaks", label: t("vaultDocs.hero.leaks") },
      ]}
      sections={SECTIONS.map((id) => ({ id, title: t(`vaultDocs.section.${id}`), body: body[id] }))}
      foot={<span>{t("vaultDocs.foot")}</span>}
    />
  );
}
