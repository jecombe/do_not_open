import { describe, expect, it } from "vitest";
import { allowListAddress, allowListMessage, duelStandings, playerPoints, rosettePlace, type SettledDuel } from "../src/standings";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc";
const d = (tokenA: number, challenger: string, tokenB: number, accepter: string, winner: number): SettledDuel => ({
  tokenA,
  tokenB,
  challenger,
  accepter,
  winner,
  loser: winner === tokenA ? tokenB : tokenA,
});

describe("duel standings", () => {
  it("ranks by wins, then fewer losses, then the lower serial", () => {
    const s = duelStandings([d(5, A, 2, B, 5), d(5, A, 7, C, 5), d(2, B, 9, C, 2), d(9, C, 2, B, 9), d(3, A, 4, B, 3)]);
    expect(s).toEqual([
      { tokenId: 5, wins: 2, losses: 0 },
      { tokenId: 3, wins: 1, losses: 0 },
      { tokenId: 2, wins: 1, losses: 2 },
      { tokenId: 9, wins: 1, losses: 1 },
      { tokenId: 4, wins: 0, losses: 1 },
      { tokenId: 7, wins: 0, losses: 1 },
    ].sort((x, y) => y.wins - x.wins || x.losses - y.losses || x.tokenId - y.tokenId));
    expect(rosettePlace(s, 5)).toBe(1);
    expect(rosettePlace(s, 9)).toBe(3);
    expect(rosettePlace(s, 2)).toBeNull();
    // A box with no win wears nothing, even in the top three.
    expect(rosettePlace(duelStandings([d(1, A, 2, B, 1)]), 2)).toBeNull();
  });
});

describe("allow list points", () => {
  it("counts each opponent once, ignores self-duels and caps the openings", () => {
    const duels = [d(1, A, 2, B, 1), d(1, A, 2, B, 1), d(3, C, 1, A, 3), d(4, A, 5, A, 4)];
    expect(playerPoints(A, duels, [])).toEqual({ points: 3 + 2, beaten: 1, faced: 2, opened: 0 });
    expect(playerPoints(B.toUpperCase().replace("0X", "0x"), duels, [B, B])).toEqual({ points: 1 + 4, beaten: 0, faced: 1, opened: 2 });
    expect(playerPoints(C, [], Array(15).fill(C)).points).toBe(20);
  });

  it("reads back the address a claim names", () => {
    const m = allowListMessage(A.replace("aa", "AA"), new Date(0));
    expect(allowListAddress(m)).toBe(A);
    expect(allowListAddress("I, 0x12, claim")).toBeNull();
  });
});
