/**
 * Opus SDP munging (PROTOCOL.md §7).
 *
 * libwebrtc configures a sender's Opus encoder (frame size, in-band FEC, DTX,
 * channels, bitrate) from the codec parameters of the *remote* description,
 * so the phone applies the same parameters to the TV's answer before
 * `setRemoteDescription`, not only to its own offer.
 */

export type OpusPtimeMs = 10 | 20;

const OPUS_PARAMS: readonly (readonly [string, string])[] = [
  ['minptime', '10'],
  ['useinbandfec', '1'],
  ['usedtx', '0'],
  ['stereo', '0'],
  ['maxaveragebitrate', '64000'],
];

const LINE_BREAK = /\r?\n/;
const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000/i;

const splitSections = (lines: readonly string[]): string[][] => {
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      sections.push([]);
    }
    sections.at(-1)?.push(line);
  }
  return sections;
};

const mergeFmtp = (existing: string): string => {
  const params = new Map<string, string>();
  for (const pair of existing.split(';')) {
    const [name = '', value = ''] = pair.trim().split('=');
    if (name !== '') {
      params.set(name.toLowerCase(), value);
    }
  }
  for (const [name, value] of OPUS_PARAMS) {
    params.set(name, value);
  }
  return Array.from(params, ([name, value]) => `${name}=${value}`).join(';');
};

const mungeAudioSection = (section: readonly string[], ptimeMs: OpusPtimeMs): string[] => {
  const payloadTypes = section.flatMap((line) => {
    const match = OPUS_RTPMAP.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  if (payloadTypes.length === 0) {
    return [...section];
  }

  const out = section.filter((line) => !line.startsWith('a=ptime:'));
  for (const pt of payloadTypes) {
    const prefix = `a=fmtp:${pt} `;
    const fmtpIndex = out.findIndex((line) => line.startsWith(prefix));
    if (fmtpIndex >= 0) {
      out[fmtpIndex] = prefix + mergeFmtp(out[fmtpIndex]?.slice(prefix.length) ?? '');
    } else {
      const rtpmapIndex = out.findIndex((line) => line.startsWith(`a=rtpmap:${pt} `));
      out.splice(rtpmapIndex + 1, 0, prefix + mergeFmtp(''));
    }
  }
  out.push(`a=ptime:${ptimeMs}`);
  return out;
};

/**
 * Sets the Opus `fmtp` parameters and `a=ptime` on every audio section that
 * offers Opus. Idempotent, and other sections and lines are left untouched.
 */
export const mungeOpusSdp = (sdp: string, ptimeMs: OpusPtimeMs): string => {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingBreak = sdp.endsWith(eol);
  const lines = (hasTrailingBreak ? sdp.slice(0, -eol.length) : sdp).split(LINE_BREAK);

  const munged = splitSections(lines).flatMap((section) =>
    (section.at(0)?.startsWith('m=audio') ?? false) ? mungeAudioSection(section, ptimeMs) : section,
  );
  return munged.join(eol) + (hasTrailingBreak ? eol : '');
};

/** The `a=ptime` value of the first audio section, if any. */
export const sdpPtimeMs = (sdp: string): number | null => {
  const match = /^a=ptime:(\d+)/m.exec(sdp);
  return match?.[1] === undefined ? null : Number(match[1]);
};
