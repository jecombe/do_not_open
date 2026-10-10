import { useEffect, type ReactNode } from "react";
import { DocShell, Prose } from "../../docs/DocShell";
import { FlowFigure } from "../../docs/figures";
import { useLocale } from "../../i18n/locale";
import { BrandIcon } from "../../brand/logos";
import { REPO, SOURCE, SOURCE_VAULT } from "../../links";
import { homePath, projectDocsPath, vaultPath } from "../../site";
import { useT } from "./i18n";

const SECTIONS = ["what", "seal", "key", "requests", "seaport", "offers", "bid", "private", "pockets", "give", "delegate", "relayer", "leaks", "testnet", "more"] as const;

// The vault's fee is a deployment setting (VAULT_FEE_BPS, 250 by default), capped by
// SealedVault's MAX_FEE_BPS (1,000): it is not in the game's spec.
const FEE = { fee: 2.5, max: 10 };

const EXPLORER = "https://sepolia.etherscan.io/address/";

/** The vault's contracts on Sepolia, as `dno:export` last wrote them. */
const CONTRACTS = [
  { key: "vault", address: "0xb70740218931B220a06CE1ba1bD58B33f4d45abC" },
  { key: "nft", address: "0xf72Eb38f816B1B8Effa8B6036C0BA6A38D6d6f9b" },
  { key: "seaport", address: "0x0000000000000068F116a894984e2DB1123eB395" },
  { key: "listings", address: "0x6b9C5204568fdf74a5DcEf7a1be85252358D8Fa6" },
  { key: "offers", address: "0xADaE32F03d6C1678127a8BEDF024FeF38dd4FE59" },
  { key: "weth", address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" },
  { key: "registry", address: "0x00000000000000447e69651d841bD8D104Bed493" },
  { key: "pockets", address: "0x3c925f9AB849ABbcb47EC12Be0D9BDB4d9EA4395" },
  { key: "desk", address: "0x37e9D6b2180323D5a01a42e2FD911aE017F70430" },
  { key: "pocketsUsdt", address: "0x56ea8016aE3a392E7E1bdf0c7C457a3786047aAe" },
  { key: "pocketsWeth", address: "0x4e8A23DfD7a23677b023E069CB8D3A94993b1350" },
  { key: "pocketsZama", address: "0x6D1585c58238DaADF748558051BF368DAA3eceE2" },
] as const;

/** The manual's animated flow of a withdrawal through the relayer. */
const VAULT_FLOW = ["vault"] as const;

const PUBLIC = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] as const;
const HIDDEN = ["1", "2", "3", "4", "5", "6"] as const;

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
        <Prose>{[t("vaultDocs.testnet.p1", FEE)]}</Prose>
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
