import type { NemesisSpec } from "./spec";

/** Kill/victory counters live in Worker KV; `gen` follows the evolving spec because every GRUDGE bumps it. */
export interface Lineage { gen: number; kills: number; victories: number }

/** Query parameter that summons a shared nightmare on load: `?n=CODE`. */
export const SHARE_PARAM = "n";
/** itch.io embeds the build in an iframe on a foreign origin, so links must point at the game page and carry the code in the text. */
export const ITCH_PAGE_URL = "https://ivanmiao.itch.io/nemesis";
const CODE_PATTERN = /^[A-Z0-9-]{4,16}$/;

export const normalizeCode = (raw: string): string | null => {
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return CODE_PATTERN.test(code) ? code : null;
};

export const codeFromSearch = (search: string): string | null => {
  const raw = new URLSearchParams(search).get(SHARE_PARAM);
  return raw ? normalizeCode(raw) : null;
};

export interface ShareLocation { origin: string; pathname: string; hostname: string }

const isItchEmbed = (location: ShareLocation) => /(^|\.)itch\.zone$/.test(location.hostname) || /(^|\.)itch\.io$/.test(location.hostname);

/** Where a friend lands to face this code. Direct hosts get a deep link; itch embeds cannot read the query, so the page URL is used. */
export function shareUrl(location: ShareLocation, code: string, overrideBase = import.meta.env.VITE_SHARE_URL as string | undefined): string {
  if (overrideBase) return withCode(overrideBase, code);
  if (isItchEmbed(location)) return ITCH_PAGE_URL;
  return withCode(`${location.origin}${location.pathname}`, code);
}

function withCode(base: string, code: string): string {
  const url = new URL(base, "https://placeholder.invalid");
  url.searchParams.set(SHARE_PARAM, code);
  return url.origin === "https://placeholder.invalid" ? `${url.pathname}${url.search}` : url.toString();
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function lineageLine(lineage: Lineage): string {
  const parts = [`GEN ${lineage.gen}`, `${plural(lineage.kills, "summoner")} slain`];
  if (lineage.victories > 0) parts.push(`felled ${lineage.victories === 1 ? "once" : `${lineage.victories} times`}`);
  return parts.join(" · ");
}

export function shareText(spec: NemesisSpec, lineage: Lineage, url: string): string {
  const boast = lineage.kills > 0 ? `It has slain ${plural(lineage.kills, "summoner")}.` : "It has not been fed yet.";
  return `${spec.identity.name}, ${spec.identity.title}. GEN ${lineage.gen}. ${boast} Speak the code ${spec.code} in NEMESIS and it hunts you next. ${url}`;
}
