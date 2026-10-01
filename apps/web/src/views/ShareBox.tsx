import { useEffect, useMemo, useState } from "react";
import type { CatSpec } from "@dno/generator";
import { useT, type AppKey } from "../i18n/app";
import { buildName, cap, catNames, diseaseName } from "../i18n/names";
import { drawCard, type CardFormat, type CardText } from "../share/card";
import { boxUrl, intentUrl, NETWORKS } from "../share/links";

interface Props {
  tokenId: number;
  serial: string;
  /** The opened cat, or null while the box is sealed. */
  cat: CatSpec | null;
  /** Whether the person sharing holds the box: a holder asks to be shaken, anyone else dares. */
  mine: boolean;
  /** What a stranger pays to shake, and the part its holder keeps. */
  shakeFee: string;
  holderShare: number;
}

type CaptionKey = Extract<AppKey, `share.${"sealedMine" | "sealedTheirs" | "opened"}.${number}` | "share.golden" | "share.sick" | "share.weighed">;

const SEALED_MINE: CaptionKey[] = ["share.sealedMine.1", "share.sealedMine.2", "share.sealedMine.3", "share.sealedMine.4"];
const SEALED_THEIRS: CaptionKey[] = ["share.sealedTheirs.1", "share.sealedTheirs.2", "share.sealedTheirs.3"];
const OPENED: CaptionKey[] = ["share.opened.1", "share.opened.2", "share.opened.3", "share.opened.4"];

interface Card {
  format: CardFormat;
  file: File;
  src: string;
}

const canShareFiles = (file: File) => {
  try {
    return !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
};

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function download(file: File) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Send a box around: a caption picked from a few, rolled again on demand, a link for each
 * network, and a picture card for the ones that only take pictures (Instagram, TikTok).
 * Sealed, it asks people to come and shake; opened, it shows the cat off.
 */
export function ShareBox({ tokenId, serial, cat, mine, shakeFee, holderShare }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AppKey | null>(null);
  const [drawing, setDrawing] = useState<CardFormat | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const url = useMemo(() => boxUrl(tokenId), [tokenId]);
  const where = url.replace(/^https?:\/\//, "");

  useEffect(() => () => void (card && URL.revokeObjectURL(card.src)), [card]);

  const names = cat ? catNames(cat) : null;
  const captions: CaptionKey[] = !cat
    ? mine
      ? SEALED_MINE
      : SEALED_THEIRS
    : cat.rarity.golden
      ? ["share.golden", ...OPENED]
      : cat.weight?.sick
        ? ["share.sick", ...OPENED]
        : cat.weight
          ? ["share.weighed", ...OPENED]
          : OPENED;
  // A cat with a story (gold, sick, weighed) tells it first; otherwise each visit starts on a different line.
  const [pick, setPick] = useState(() => (captions.length > OPENED.length ? 0 : Math.floor(Math.random() * captions.length)));
  const caption = t(captions[pick % captions.length]!, {
    serial,
    fee: shakeFee,
    share: holderShare,
    breed: names?.breed.toLowerCase() ?? "",
    mood: names?.mood.toLowerCase() ?? "",
    state: names?.state.toLowerCase() ?? "",
    tier: names?.tier ?? "",
    score: cat?.rarity.score ?? 0,
    build: cat?.weight ? buildName(cat.weight.build).toLowerCase() : "",
    disease: cat?.weight?.disease ? diseaseName(cat.weight.disease).toLowerCase() : "",
    weight: cat?.weight ? cat.weight.weight.toLocaleString() : "",
  });

  const cardText = (): CardText =>
    cat && names
      ? {
          serial,
          head: t("decl.title"),
          badge: names.tier,
          lines: [
            cap(`${names.breed.toLowerCase()}, ${names.mood.toLowerCase()}, ${names.state.toLowerCase()}`),
            t("card.score", { score: cat.rarity.score }),
            ...(cat.rarity.golden
              ? [t("card.golden")]
              : cat.weight
                ? [
                    t("decl.weightValue", { build: buildName(cat.weight.build), n: cat.weight.weight.toLocaleString() }) +
                      (cat.weight.sick && cat.weight.disease ? `. ${diseaseName(cat.weight.disease)}` : ""),
                  ]
                : []),
          ],
          stamp: t("card.stampOpened"),
          where: t("card.seeAt", { where }),
        }
      : {
          serial,
          head: t("box.consignment"),
          lines: [t("card.sealed1"), t("card.sealed2")],
          stamp: t("card.stampSealed"),
          where: t("card.shakeAt", { where }),
        };

  const makeCard = async (format: CardFormat) => {
    setDrawing(format);
    setStatus(null);
    try {
      const blob = await drawCard({ tokenId, cat, text: cardText(), format });
      setCard({ format, file: new File([blob], `${serial}-${format}.png`, { type: "image/png" }), src: URL.createObjectURL(blob) });
    } catch (error) {
      console.warn("[share] card", error);
      setStatus("share.cardFailed");
    } finally {
      setDrawing(null);
    }
  };

  // A fresh tap, not the end of the drawing: phones only open their share sheet on a gesture.
  const sendCard = async () => {
    if (!card) return;
    try {
      await navigator.share({ files: [card.file], text: `${caption}\n${url}` });
      setStatus("share.cardShared");
    } catch (error) {
      if ((error as Error).name !== "AbortError") saveCard();
    }
  };

  const saveCard = () => {
    if (!card) return;
    download(card.file);
    void copy(`${caption}\n${url}`);
    setStatus("share.cardSaved");
  };

  const shareNative = async () => {
    try {
      await navigator.share({ title: serial, text: caption, url });
    } catch {
      // Closed without sending.
    }
  };

  if (!open)
    return (
      <button type="button" className="link share-toggle" onClick={() => setOpen(true)}>
        <span aria-hidden="true">↗</span> {t("share.open")}
      </button>
    );

  return (
    <div className="share">
      <div className="share-head">
        <span>{cat ? t("share.openedHead") : t("share.sealedHead")}</span>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          {t("share.close")}
        </button>
      </div>
      <blockquote className="share-caption">
        <p>{caption}</p>
        <button type="button" className="share-reroll" onClick={() => setPick((p) => p + 1)} title={t("share.another")}>
          <span aria-hidden="true">🎲</span> {t("share.another")}
        </button>
      </blockquote>
      <div className="picker share-nets">
        {NETWORKS.map((n) => (
          <a key={n.key} href={intentUrl(n.key, caption, url)} target="_blank" rel="noreferrer">
            {n.name}
          </a>
        ))}
        {typeof navigator.share === "function" && (
          <button type="button" onClick={() => void shareNative()}>
            {t("share.more")}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void copy(url).then((ok) => setStatus(ok ? "share.copied" : null));
          }}
        >
          {t("share.copyLink")}
        </button>
      </div>

      <p className="fine share-hint">{t("share.cardsHint")}</p>
      <div className="picker share-cards">
        {(["post", "story"] as const).map((f) => (
          <button type="button" key={f} onClick={() => void makeCard(f)} disabled={!!drawing} aria-pressed={card?.format === f}>
            {drawing === f ? t("share.drawing") : f === "post" ? t("share.cardPost") : t("share.cardStory")}
          </button>
        ))}
      </div>
      {card && (
        <figure className={`share-card is-${card.format}`}>
          <img src={card.src} alt={serial} />
          <figcaption className="actions">
            {canShareFiles(card.file) && (
              <button type="button" className="stamp-button" onClick={() => void sendCard()}>
                {t("share.sendCard")}
              </button>
            )}
            <button type="button" className="plain-button" onClick={saveCard}>
              {t("share.saveCard")}
            </button>
          </figcaption>
        </figure>
      )}
      {status && (
        <p className={`fine${status === "share.cardFailed" ? " problem" : ""}`} aria-live="polite">
          {t(status)}
        </p>
      )}
    </div>
  );
}
