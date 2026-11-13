import { describe, expect, it } from 'vitest';

import { mungeOpusSdp, OPUS_FMTP_PARAMS } from '@/features/remote-mic/opus-sdp';

const CHROME_ANSWER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=mid:0',
  'a=recvonly',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:126 telephone-event/8000',
  '',
].join('\r\n');

const fmtpOf = (sdp: string, pt: string): Map<string, string> => {
  const line = sdp.split('\r\n').find((candidate) => candidate.startsWith(`a=fmtp:${pt} `));
  return new Map(
    (line ?? '')
      .slice(`a=fmtp:${pt} `.length)
      .split(';')
      .map((pair) => {
        const [key, value] = pair.split('=');
        return [key, value] as [string, string];
      }),
  );
};

describe('mungeOpusSdp', () => {
  it('sets the contract Opus parameters and a 10 ms ptime', () => {
    const munged = mungeOpusSdp(CHROME_ANSWER);
    const params = fmtpOf(munged, '111');
    for (const [key, value] of Object.entries(OPUS_FMTP_PARAMS)) {
      expect(params.get(key)).toBe(value);
    }
    expect(munged.split('\r\n').filter((line) => line === 'a=ptime:10')).toHaveLength(1);
  });

  it('leaves other codecs and session lines untouched', () => {
    const munged = mungeOpusSdp(CHROME_ANSWER);
    expect(munged).toContain('a=fmtp:63 111/111');
    expect(munged).toContain('a=rtpmap:9 G722/8000');
    expect(munged.startsWith('v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n')).toBe(true);
    expect(munged.endsWith('\r\n')).toBe(true);
  });

  it('is idempotent and replaces an existing ptime', () => {
    const once = mungeOpusSdp(CHROME_ANSWER.replace('a=recvonly', 'a=recvonly\r\na=ptime:20'));
    expect(once).not.toContain('a=ptime:20');
    expect(mungeOpusSdp(once)).toBe(once);
  });

  it('adds an fmtp line when Opus has none', () => {
    const bare = CHROME_ANSWER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
    const munged = mungeOpusSdp(bare);
    const lines = munged.split('\r\n');
    const rtpmap = lines.indexOf('a=rtpmap:111 opus/48000/2');
    expect(lines[rtpmap + 1]).toMatch(/^a=fmtp:111 /);
    expect(fmtpOf(munged, '111').get('stereo')).toBe('0');
  });

  it('does not touch audio sections without Opus or video sections', () => {
    const sdp = [
      'v=0',
      'm=audio 9 RTP/AVP 0',
      'a=rtpmap:0 PCMU/8000',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
      '',
    ].join('\r\n');
    expect(mungeOpusSdp(sdp)).toBe(sdp);
  });
});
