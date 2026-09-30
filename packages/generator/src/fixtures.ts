/**
 * Five fixed seeds used for design work, mock mode and snapshot tests.
 * Chosen to cover every state and a spread of breeds and rarities.
 */
export const FIXTURE_SEEDS: readonly { label: string; seed: bigint }[] = [
  { label: "Alive tabby", seed: 0x4d19465f141e2ee0n },
  { label: "Asleep orange", seed: 0x138c820aec78c350n },
  { label: "Ghost siamese", seed: 0x20e1fafa64beea60n },
  { label: "Quantum glitch", seed: 0x05fce6d782fffde8n },
  { label: "Alive void", seed: 0x8cf5c8bef5d70bb8n },
];
