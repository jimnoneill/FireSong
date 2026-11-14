/** Local ICE candidates by type; `mdns` counts host candidates hidden behind a `.local` name. */
export type CandidateCounts = {
  host: number;
  srflx: number;
  prflx: number;
  relay: number;
  mdns: number;
};

/**
 * What the phone's own addresses say about reaching the TV: `lan` when a
 * private address is present, `mobile-like` when only public or carrier-NAT
 * addresses are, `unknown` when the browser hid them all (mDNS) or gathered none.
 */
export type LocalReach = 'lan' | 'mobile-like' | 'unknown';

export type CandidateSummary = {
  counts: CandidateCounts;
  privateSeen: boolean;
  reach: LocalReach;
};

type AddressKind = 'private' | 'public' | 'mdns' | 'ignored';

const CANDIDATE_LINE = /^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

type Ipv4Range = { first: number; secondFrom: number; secondTo: number; kind: AddressKind };

/** 10/8, 172.16/12 and 192.168/16 are home networks; loopback, 0/8 and link-local say nothing. */
const IPV4_RANGES: readonly Ipv4Range[] = [
  { first: 10, secondFrom: 0, secondTo: 255, kind: 'private' },
  { first: 172, secondFrom: 16, secondTo: 31, kind: 'private' },
  { first: 192, secondFrom: 168, secondTo: 168, kind: 'private' },
  { first: 127, secondFrom: 0, secondTo: 255, kind: 'ignored' },
  { first: 0, secondFrom: 0, secondTo: 255, kind: 'ignored' },
  { first: 169, secondFrom: 254, secondTo: 254, kind: 'ignored' },
];

const ipv4Kind = (first: number, second: number): AddressKind =>
  IPV4_RANGES.find(
    (range) => range.first === first && second >= range.secondFrom && second <= range.secondTo,
  )?.kind ?? 'public';

const ipv6Kind = (address: string): AddressKind => {
  const head = Number.parseInt(address.split(':')[0] ?? '', 16);
  if (Number.isNaN(head) || address === '::1') {
    return 'ignored';
  }
  if ((head & 0xfe00) === 0xfc00) {
    return 'private';
  }
  return (head & 0xffc0) === 0xfe80 ? 'ignored' : 'public';
};

/** Classifies one candidate address; never stores or returns the address itself. */
export const addressKind = (address: string): AddressKind => {
  const lower = address.toLowerCase();
  if (lower.endsWith('.local')) {
    return 'mdns';
  }
  const ipv4 = IPV4.exec(lower);
  if (ipv4 !== null) {
    return ipv4Kind(Number(ipv4[1]), Number(ipv4[2]));
  }
  return lower.includes(':') ? ipv6Kind(lower) : 'ignored';
};

const emptyCounts = (): CandidateCounts => ({ host: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 });

const countType = (counts: CandidateCounts, type: string): void => {
  if (type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay') {
    counts[type] += 1;
  }
};

type HostSeen = { privateSeen: boolean; publicSeen: boolean };

const noteHost = (counts: CandidateCounts, seen: HostSeen, address: string): void => {
  const kind = addressKind(address);
  counts.mdns += kind === 'mdns' ? 1 : 0;
  seen.privateSeen ||= kind === 'private';
  seen.publicSeen ||= kind === 'public';
};

const reachOf = (seen: HostSeen): LocalReach => {
  if (seen.privateSeen) {
    return 'lan';
  }
  return seen.publicSeen ? 'mobile-like' : 'unknown';
};

/**
 * Reads the `a=candidate` lines of the phone's own SDP (PHONE-V2.md, feature 8).
 * Only the phone's host candidates decide the reach: a private IPv4 address or
 * an IPv6 ULA means a home network; real addresses without one look like
 * mobile data.
 */
export const summarizeLocalCandidates = (sdp: string): CandidateSummary => {
  const counts = emptyCounts();
  const seen: HostSeen = { privateSeen: false, publicSeen: false };

  for (const line of sdp.split(/\r?\n/)) {
    const match = CANDIDATE_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const [, address = '', type = ''] = match;
    countType(counts, type);
    if (type === 'host') {
      noteHost(counts, seen, address);
    }
  }

  return { counts, privateSeen: seen.privateSeen, reach: reachOf(seen) };
};
