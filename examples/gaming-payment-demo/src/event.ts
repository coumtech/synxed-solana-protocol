// Fake in-game audio-ad impression generator.
//
// This is a stand-in for whatever platform emits billable events. It exists
// so the demo runs with zero proprietary dependencies — any real integration
// would construct the same `SettlementRequest` from its own event source.

import { randomUUID } from "node:crypto";

export interface FakeAdImpression {
  eventId: string;
  occurredAt: string;
  gameTitle: string;
  trackTitle: string;
  artistName: string;
}

const GAMES = ["Neon Drift", "Skyline Runners", "Harbor Tycoon"] as const;
const TRACKS = ["Midnight Static", "Glass Waves", "Low Orbit"] as const;
const ARTISTS = ["Nova Court", "The Analog Suns", "Mira Vale"] as const;

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) {
    throw new Error("cannot pick from an empty list");
  }
  return item;
}

export function fakeAudioAdImpression(): FakeAdImpression {
  return {
    eventId: `evt_${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    gameTitle: pick(GAMES),
    trackTitle: pick(TRACKS),
    artistName: pick(ARTISTS),
  };
}
