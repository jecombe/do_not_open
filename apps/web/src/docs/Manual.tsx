import { useEffect, useState } from "react";
import { spec } from "@dno/game-spec";
import { ArchFigure, FlowFigure, HeroFigure, SeedFigure } from "./figures";

const REPO = "https://github.com/jecombe/do_not_open";
const DOCS = `${REPO}/blob/dev/docs`;
const CONTRACT = "0x6C6210E9CB6CC5218F479806258E86B176aA5BD0";

const SECTIONS = [
  { id: "box", title: "What is in a box" },
  { id: "seed", title: "One number per cat" },
  { id: "privacy", title: "Who can read what" },
  { id: "flows", title: "How things come out" },
  { id: "mechanics", title: "Eight things to do" },
  { id: "transfer", title: "What a sale changes" },
  { id: "code", title: "How the code is laid out" },
  { id: "solana", title: "Moving to Solana" },
  { id: "mainnet", title: "Before mainnet" },
  { id: "more", title: "Full reference" },
] as const;

/** Highlights the section being read in the routing slip. */
function useCurrentSection(): string {
  const [current, setCurrent] = useState<string>(SECTIONS[0].id);
  useEffect(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setCurrent(e.target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) seen.observe(el);
    }
    return () => seen.disconnect();
  }, []);
  return current;
}

const supply = spec.collection.maxSupply.toLocaleString("en");

export function Manual() {
  const current = useCurrentSection();

  return (
    <div className="manual">
      <header className="top">
        <a className="wordmark" href="/" aria-label="DO NOT OPEN, back to the depot">
          Do not open
        </a>
        <nav className="views" aria-label="Site">
          <a href="/">Back to the depot</a>
          <a href={REPO}>Source</a>
        </nav>
      </header>

      <section className="hero">
        <h1>Handling instructions</h1>
        <div>
          <p className="lede">
            {supply} sealed boxes on a public chain. There is a cat in each one, and nobody can read what it is: not the holder, not the people who deployed it, not the chain. This is how that works, and what it takes to look.
          </p>
          <p className="hero-links">
            <a className="stamp-link" href="#seed">
              Start with the seed
            </a>
            <a href="/">or go shake a box</a>
          </p>
        </div>
        <HeroFigure />
      </section>

      <div className="layout">
        <nav className="toc" aria-label="Contents">
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} aria-current={current === s.id ? "true" : undefined}>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <main>
          <section id="box">
            <h2>What is in a box</h2>
            <div className="prose">
              <p>
                DO NOT OPEN is a collection of {supply} NFTs on Ethereum, built on Zama's FHEVM. Each token is a cardboard box. When a box is minted, the contract draws a random number for it and keeps that number encrypted. The cat inside, its state, its five traits and its rarity are all worked out from that one number.
              </p>
              <p>
                Encrypted here does not mean hidden behind a server or revealed later from a list someone prepared. The number is a ciphertext on-chain from the moment it exists. The contract can still compute with it: compare it, cut a piece out of it, add to it. It does that without ever decrypting it, which is what fully homomorphic encryption is for.
              </p>
              <p>
                So the game is about what you choose to find out, and what that costs you. Shake a box and you learn one thing about it, privately. Open it and everyone learns everything, for good.
              </p>
            </div>
          </section>

          <section id="seed">
            <h2>One number per cat</h2>
            <div className="prose">
              <p>
                A box holds a single 64-bit seed. Its bits are cut into seven fields. Sixteen decide whether the cat is alive, asleep, a ghost or quantum. Five bytes are the five traits. The last byte only changes how the cat looks.
              </p>
            </div>
            <SeedFigure />
            <div className="prose">
              <p>
                Storing one ciphertext instead of eight keeps a mint down to a single encrypted operation. Everything else is derived when a mechanic needs it, under encryption while the box is sealed and in plain Solidity once the seed is public. The same decoding exists in TypeScript, and tests hold the two to the same answer for every seed.
              </p>
              <p>
                The rarity score is a weighted sum: three times the breed roll, the mood roll, twice the accessory roll, the broken thing, the room, plus a bonus for the state. A quantum cat starts 1,000 points ahead. The highest possible score is {spec.rarity.maxScore.toLocaleString("en")}.
              </p>
            </div>
          </section>

          <section id="privacy">
            <h2>Who can read what</h2>
            <div className="prose">
              <p>
                Every ciphertext has an access list. For the seed, that list has one entry: the contract. No holder is ever added to it, because an address on the list could ask the key service to decrypt the seed directly and skip the game.
              </p>
            </div>
            <div className="form">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Fact</th>
                    <th scope="col">The holder</th>
                    <th scope="col">Everyone else</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">The seed, the state, the score</th>
                    <td>No</td>
                    <td>No</td>
                  </tr>
                  <tr>
                    <th scope="row">One trait per shake</th>
                    <td>Yes, free</td>
                    <td>Yes, by paying</td>
                  </tr>
                  <tr>
                    <th scope="row">Which trait a shake picked</th>
                    <td colSpan={2}>Only whoever shook</td>
                  </tr>
                  <tr>
                    <th scope="row">Whether it is alive</th>
                    <td colSpan={2}>Everyone, if the holder asks. One bit, once per box</td>
                  </tr>
                  <tr>
                    <th scope="row">Who won a duel, and one trait of the loser</th>
                    <td colSpan={2}>Everyone</td>
                  </tr>
                  <tr>
                    <th scope="row">The winner's trait in a duel</th>
                    <td>No</td>
                    <td>No</td>
                  </tr>
                  <tr>
                    <th scope="row">How many times it was fed</th>
                    <td colSpan={2}>Everyone</td>
                  </tr>
                  <tr>
                    <th scope="row">How much affection that earned</th>
                    <td>No</td>
                    <td>No</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="prose">
              <p>
                Two consequences are deliberate. A holder who shakes often enough learns all five traits: a shake shows one of five at random, so about eleven cover them. What stays hidden even from the holder is the state, which is worth up to a third of the score, and the affection. And duels leak order: each one publishes which of two boxes scores higher. That is the price of duelling.
              </p>
            </div>
          </section>

          <section id="flows">
            <h2>How things come out</h2>
            <div className="prose">
              <p>
                There are two ways out of encryption. A private decryption re-encrypts a value for one person, who must be on its access list. A public decryption publishes a value with signatures from the parties that share the key, and the contract verifies those signatures before it believes anything.
              </p>
              <p>
                The contract never receives a callback. A reveal is a request on-chain, a decryption off-chain, and a second transaction that carries the proof back. Anyone may send that second transaction.
              </p>
            </div>
            <FlowFigure />
          </section>

          <section id="mechanics">
            <h2>Eight things to do</h2>
            <div className="form">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col">Who</th>
                    <th scope="col">Cost on Sepolia</th>
                    <th scope="col">What becomes public</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Mint</th>
                    <td>Anyone, up to {String(spec.mechanics.mint?.maxPerTx ?? 10)} at a time</td>
                    <td>0.002 ETH</td>
                    <td>That a box exists</td>
                  </tr>
                  <tr>
                    <th scope="row">Shake</th>
                    <td>The holder</td>
                    <td>Gas only</td>
                    <td>That a shake happened</td>
                  </tr>
                  <tr>
                    <th scope="row">Paid shake</th>
                    <td>Anyone but the holder</td>
                    <td>0.001 ETH, 70% to the holder</td>
                    <td>That a shake happened</td>
                  </tr>
                  <tr>
                    <th scope="row">Feed</th>
                    <td>Anyone</td>
                    <td>0.0002 ETH</td>
                    <td>The number of feeds, not what they earned</td>
                  </tr>
                  <tr>
                    <th scope="row">Alive check</th>
                    <td>The holder, once</td>
                    <td>Gas only</td>
                    <td>One bit: alive or not</td>
                  </tr>
                  <tr>
                    <th scope="row">Entangle</th>
                    <td>Both holders</td>
                    <td>Gas only</td>
                    <td>The link. Opening one box then opens both</td>
                  </tr>
                  <tr>
                    <th scope="row">Duel</th>
                    <td>Both holders</td>
                    <td>Gas only</td>
                    <td>Who won, and one trait of the loser</td>
                  </tr>
                  <tr>
                    <th scope="row">Open</th>
                    <td>The holder</td>
                    <td>0.0005 ETH</td>
                    <td>Everything, permanently</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="prose">
              <p>
                Feeding adds a hidden amount between {spec.affection.perFeedMin} and {spec.affection.perFeedMax} to a hidden counter. If every feed added exactly one, counting feeds would give the counter away. Past {spec.affection.goldenThreshold}, the accessory turns golden when the box is opened, and a cat with no accessory gets a golden bell collar.
              </p>
            </div>
          </section>

          <section id="transfer">
            <h2>What a sale changes</h2>
            <div className="prose">
              <p>
                On this protocol an access grant cannot be revoked. A design that put the holder on the seed's access list could never take the seller off it. This one never puts anyone on, so a transfer has nothing to move and nothing to undo.
              </p>
            </div>
            <ol className="timeline">
              <li>
                <strong>Mint</strong>
                <span>Seed: the contract only.</span>
              </li>
              <li>
                <strong>Alice shakes</strong>
                <span>A fresh ciphertext holding one trait: the contract and Alice.</span>
              </li>
              <li>
                <strong>Alice sells to Bob</strong>
                <span>No list changes.</span>
              </li>
              <li>
                <strong>Bob shakes</strong>
                <span>Another fresh ciphertext: the contract and Bob.</span>
              </li>
              <li>
                <strong>Alice tries again</strong>
                <span>Refused. She keeps what she already saw, and gets nothing new.</span>
              </li>
            </ol>
            <div className="prose">
              <p>If you buy a sealed box, assume the seller knows its five traits. A few paid shakes before buying level that.</p>
            </div>
          </section>

          <section id="code">
            <h2>How the code is laid out</h2>
            <div className="prose">
              <p>
                The repository is split so that most of it does not know which chain it runs on. The rules, the generator, the 3D scene and this app sit on one side. The contract and the code that talks to it sit on the other, behind one interface.
              </p>
            </div>
            <ArchFigure />
            <div className="prose">
              <p>
                A sealed box is drawn from its token id and nothing else. The function that describes a box cannot see a seed, so no render, texture or metadata file of a sealed box can leak one. The cat exists as data only once the seed is public.
              </p>
            </div>
          </section>

          <section id="solana">
            <h2>Moving to Solana</h2>
            <div className="prose">
              <p>
                Zama lists Solana support on its roadmap and has published no Solana SDK yet. So there is a map, and no port. What the map says: about two thirds of the code does not change, the contract becomes a program with one account per box, and one new adapter implements the same interface.
              </p>
            </div>
            <div className="form">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Today on Ethereum</th>
                    <th scope="col">Expected on Solana</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Encrypted values in contract storage</td>
                    <td>Ciphertext handles in program accounts</td>
                  </tr>
                  <tr>
                    <td>One mapping entry per token</td>
                    <td>One account per box, derived from the token id</td>
                  </tr>
                  <tr>
                    <td>Permit signed with the wallet's Ethereum key</td>
                    <td>A message signed with its ed25519 key</td>
                  </tr>
                  <tr>
                    <td>Proof verified in one transaction</td>
                    <td>Unknown. A transaction is limited to 1,232 bytes, and a proof may not fit</td>
                  </tr>
                  <tr>
                    <td>Finding your boxes by scanning owners</td>
                    <td>An indexer query, which is easier</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="prose">
              <p>
                Every line of the right-hand column has to be checked against the real SDK when it ships. <a href={`${DOCS}/SOLANA_PORTING.md`}>The full porting map</a> lists the open questions.
              </p>
            </div>
          </section>

          <section id="mainnet">
            <h2>Before mainnet</h2>
            <div className="prose">
              <p>
                The contract runs on the Sepolia testnet at <a href={`https://sepolia.etherscan.io/address/${CONTRACT}`}>{CONTRACT.slice(0, 6)}…{CONTRACT.slice(-4)}</a>. It has been reviewed by the people who wrote it and by nobody else. It should not hold real money until that changes. These points are open:
              </p>
            </div>
            <ul className="findings">
              <li>
                <strong>A box can get stuck while opening.</strong> If the key service never answers, there is no timeout and no refund.
              </li>
              <li>
                <strong>Nothing limits one minter.</strong> A bot cannot pick good boxes, but it can mint all of them.
              </li>
              <li>
                <strong>The owner can repoint the metadata.</strong> There is no freeze, and the owner is a single key.
              </li>
              <li>
                <strong>Two deploy-time checks are missing.</strong> The config contract trusts that the score fits sixteen bits and that trait offsets do not overlap.
              </li>
              <li>
                <strong>Marketplaces are not told when a box opens.</strong> The contract does not emit a metadata update event.
              </li>
              <li>
                <strong>The mainnet relayer needs a key kept server-side.</strong> The proxy for it does not exist.
              </li>
              <li>
                <strong>No external audit, no static analysis, no fuzzing.</strong>
              </li>
            </ul>
            <div className="prose">
              <p>
                <a href={`${DOCS}/AUDIT_CHECKLIST.md`}>The audit checklist</a> has each check, the test that backs it, and the rest of the findings.
              </p>
            </div>
          </section>

          <section id="more">
            <h2>Full reference</h2>
            <ul className="refs">
              <li>
                <a href={`${DOCS}/ARCHITECTURE.md`}>Architecture</a>
                <span>Packages, data flow, the 3D pipeline</span>
              </li>
              <li>
                <a href={`${DOCS}/DATA_MODEL.md`}>Data model</a>
                <span>What is encrypted, per token, and the access lists</span>
              </li>
              <li>
                <a href={`${DOCS}/FLOWS.md`}>Flows</a>
                <span>Sequence diagrams for every mechanic</span>
              </li>
              <li>
                <a href={`${DOCS}/ZAMA_NOTES.md`}>Zama notes</a>
                <span>Verified versions, and where the protocol differs from the first brief</span>
              </li>
              <li>
                <a href={`${DOCS}/DESIGN.md`}>Design</a>
                <span>Art direction, effects, performance budget</span>
              </li>
              <li>
                <a href={`${REPO}/blob/dev/packages/contracts-evm/README.md`}>Contracts</a>
                <span>Cost of each function, deploy, command line</span>
              </li>
            </ul>
          </section>
        </main>
      </div>

      <footer className="foot">
        <span>DO NOT OPEN runs on a testnet. Nothing here is worth money.</span>
        <a href="/">Back to the depot</a>
      </footer>
    </div>
  );
}
