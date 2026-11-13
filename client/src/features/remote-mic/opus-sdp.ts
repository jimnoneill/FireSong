/**
 * Opus SDP munging for phone mics (PROTOCOL.md §7). libwebrtc picks a
 * sender's Opus frame size from the remote description's `ptime`, so the
 * phone's offer and the TV's answer both carry the same parameters.
 */

export const OPUS_FMTP_PARAMS: Readonly<Record<string, string>> = {
  minptime: '10',
  useinbandfec: '1',
  usedtx: '0',
  stereo: '0',
  maxaveragebitrate: '64000',
};

export const OPUS_PTIME_MS = 10;

const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000/i;

const opusPayloadTypes = (lines: readonly string[]): Set<string> => {
  const types = new Set<string>();
  for (const line of lines) {
    const match = OPUS_RTPMAP.exec(line);
    if (match !== null) {
      types.add(match[1]);
    }
  }
  return types;
};

const mergeFmtp = (line: string, payloadType: string): string => {
  const prefix = `a=fmtp:${payloadType} `;
  const params = new Map<string, string>();
  for (const pair of line.slice(prefix.length).split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key !== '') {
      params.set(key, rest.join('='));
    }
  }
  for (const [key, value] of Object.entries(OPUS_FMTP_PARAMS)) {
    params.set(key, value);
  }
  return `${prefix}${[...params].map(([key, value]) => `${key}=${value}`).join(';')}`;
};

const defaultFmtp = (payloadType: string): string =>
  mergeFmtp(`a=fmtp:${payloadType} `, payloadType);

const mungeAudioLine = (
  line: string,
  payloadTypes: ReadonlySet<string>,
  section: readonly string[],
): string[] => {
  if (line.startsWith('a=ptime:')) {
    return [];
  }
  const fmtp = /^a=fmtp:(\d+) /.exec(line);
  if (fmtp !== null && payloadTypes.has(fmtp[1])) {
    return [mergeFmtp(line, fmtp[1])];
  }
  const rtpmap = OPUS_RTPMAP.exec(line);
  if (rtpmap !== null && !section.some((other) => other.startsWith(`a=fmtp:${rtpmap[1]} `))) {
    return [line, defaultFmtp(rtpmap[1])];
  }
  return [line];
};

const mungeAudioSection = (section: readonly string[], ptimeMs: number): string[] => {
  const payloadTypes = opusPayloadTypes(section);
  if (payloadTypes.size === 0) {
    return [...section];
  }
  return [
    ...section.flatMap((line) => mungeAudioLine(line, payloadTypes, section)),
    `a=ptime:${ptimeMs}`,
  ];
};

/** Splits an SDP into its session part and one block per `m=` section. */
const sections = (lines: readonly string[]): string[][] => {
  const blocks: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      blocks.push([]);
    }
    blocks[blocks.length - 1].push(line);
  }
  return blocks;
};

/**
 * Sets the Opus `fmtp` parameters and `a=ptime` on every audio section that
 * offers Opus. Other sections and lines are kept byte for byte.
 */
export const mungeOpusSdp = (sdp: string, ptimeMs: number = OPUS_PTIME_MS): string => {
  const lines = sdp.split(/\r?\n/);
  const trailing = lines.at(-1) === '' ? lines.pop() : undefined;
  const munged = sections(lines).flatMap((block) =>
    (block.at(0)?.startsWith('m=audio') ?? false) ? mungeAudioSection(block, ptimeMs) : block,
  );
  return `${munged.join('\r\n')}${trailing === undefined ? '' : '\r\n'}`;
};
