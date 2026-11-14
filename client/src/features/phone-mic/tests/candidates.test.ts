/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addressKind, summarizeLocalCandidates } from '@/features/phone-mic/lib/candidates';

const sdp = (...candidates: string[]): string =>
  ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', ...candidates.map((line) => `a=${line}`), ''].join(
    '\r\n',
  );

const host = (address: string, port = 50_000): string =>
  `candidate:1 1 udp 2122260223 ${address} ${String(port)} typ host generation 0`;

const srflx = (address: string): string =>
  `candidate:2 1 udp 1686052607 ${address} 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0`;

void test('a private IPv4 host candidate means the home network', () => {
  const summary = summarizeLocalCandidates(sdp(host('192.168.77.20'), srflx('203.0.113.7')));
  assert.equal(summary.reach, 'lan');
  assert.equal(summary.privateSeen, true);
  assert.deepEqual(summary.counts, { host: 1, srflx: 1, prflx: 0, relay: 0, mdns: 0 });
});

void test('10/8, 172.16/12 and IPv6 ULA count as private; 172.32 does not', () => {
  assert.equal(summarizeLocalCandidates(sdp(host('10.4.0.9'))).reach, 'lan');
  assert.equal(summarizeLocalCandidates(sdp(host('172.20.1.1'))).reach, 'lan');
  assert.equal(summarizeLocalCandidates(sdp(host('fd12:3456:789a::1'))).reach, 'lan');
  assert.equal(summarizeLocalCandidates(sdp(host('172.32.1.1'))).reach, 'mobile-like');
});

void test('only a carrier-NAT or public host address looks like mobile data', () => {
  assert.equal(summarizeLocalCandidates(sdp(host('100.64.12.3'))).reach, 'mobile-like');
  assert.equal(
    summarizeLocalCandidates(sdp(host('2001:db8::5'), srflx('198.51.100.4'))).reach,
    'mobile-like',
  );
});

void test('mDNS-only candidates, or none at all, give no hint', () => {
  const mdns = summarizeLocalCandidates(sdp(host('0b7e5c1a-5d3f-4c2e-9a8b-1f2e3d4c5b6a.local')));
  assert.equal(mdns.reach, 'unknown');
  assert.equal(mdns.counts.mdns, 1);
  assert.equal(mdns.privateSeen, false);
  assert.equal(summarizeLocalCandidates(sdp()).reach, 'unknown');
});

void test('loopback and link-local addresses say nothing about the network', () => {
  assert.equal(addressKind('127.0.0.1'), 'ignored');
  assert.equal(addressKind('169.254.10.2'), 'ignored');
  assert.equal(addressKind('fe80::1'), 'ignored');
  assert.equal(summarizeLocalCandidates(sdp(host('169.254.10.2'))).reach, 'unknown');
});

void test('the summary never carries an address', () => {
  const summary = summarizeLocalCandidates(sdp(host('192.168.77.20'), host('203.0.113.7')));
  assert.equal(JSON.stringify(summary).includes('192.168'), false);
  assert.equal(JSON.stringify(summary).includes('203.0'), false);
});
