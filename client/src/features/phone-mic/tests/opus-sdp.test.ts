/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mungeOpusSdp, sdpPtimeMs } from '@/features/phone-mic/lib/opus-sdp';
import { CHROME_OFFER } from '@/features/phone-mic/tests/fixtures';

void test('sets the Opus parameters and ptime, keeping everything else', () => {
  const munged = mungeOpusSdp(CHROME_OFFER, 10);
  const lines = munged.split('\r\n');

  assert.ok(
    lines.includes(
      'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=0;stereo=0;maxaveragebitrate=64000',
    ),
  );
  assert.ok(lines.includes('a=ptime:10'));
  assert.ok(lines.includes('a=fmtp:63 111/111'));
  assert.ok(lines.includes('a=rtcp-fb:111 transport-cc'));
  assert.equal(lines.length, CHROME_OFFER.split('\r\n').length + 1);
  assert.ok(munged.endsWith('\r\n'));
});

void test('is idempotent and switches between 10 and 20 ms', () => {
  const ten = mungeOpusSdp(CHROME_OFFER, 10);
  assert.equal(mungeOpusSdp(ten, 10), ten);

  const twenty = mungeOpusSdp(ten, 20);
  assert.equal(sdpPtimeMs(twenty), 20);
  assert.equal(twenty.match(/a=ptime:/g)?.length, 1);
});

void test('adds an fmtp line when the section has none', () => {
  const bare = 'v=0\nm=audio 9 RTP/AVP 109\na=rtpmap:109 OPUS/48000/2\na=sendonly\n';
  const munged = mungeOpusSdp(bare, 10);

  assert.equal(
    munged,
    'v=0\nm=audio 9 RTP/AVP 109\na=rtpmap:109 OPUS/48000/2\n' +
      'a=fmtp:109 minptime=10;useinbandfec=1;usedtx=0;stereo=0;maxaveragebitrate=64000\n' +
      'a=sendonly\na=ptime:10\n',
  );
});

void test('leaves non-Opus and non-audio sections alone', () => {
  const sdp = [
    'v=0',
    'm=audio 9 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    'm=video 9 RTP/AVP 96',
    'a=rtpmap:96 VP8/90000',
    '',
  ].join('\n');

  assert.equal(mungeOpusSdp(sdp, 10), sdp);
  assert.equal(sdpPtimeMs(sdp), null);
});
