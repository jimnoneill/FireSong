#!/usr/bin/env bash
# Generates the S1 probe's local test media (git-ignored):
#   test.mp4    2 s 1280x720 H.264 + AAC, +faststart (ffmpeg testsrc + sine)
#   tls/        optional (--tls): throwaway CA + leaf for https://localhost, and a
#               self-signed "stranger" leaf for the pin-fallback test. The CA key
#               is deleted right after signing, so the CA can sign nothing else.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -s test.mp4 ]; then
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=2" \
    -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=2" \
    -c:v libx264 -pix_fmt yuv420p -profile:v main -c:a aac -b:a 128k \
    -movflags +faststart -shortest test.mp4
  echo "wrote probe/test.mp4"
fi

if [ "${1:-}" = "--tls" ]; then
  mkdir -p tls && cd tls
  if [ ! -s leaf.pem ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
      -keyout ca.key -out ca.pem -days 7 \
      -subj "/O=FireSong/CN=FireSong S1 throwaway test CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
      -keyout leaf.key -out leaf.csr -subj "/CN=localhost" 2>/dev/null
    printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > leaf.ext
    openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
      -days 7 -extfile leaf.ext -out leaf.pem 2>/dev/null
    rm -f ca.key leaf.csr ca.srl
    # Stranger: self-signed, not under the test CA (for the leaf-pin fallback).
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
      -keyout stranger.key -out stranger.pem -days 7 -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost" 2>/dev/null
    echo "wrote probe/tls/{ca.pem,leaf.pem,leaf.key,stranger.pem,stranger.key} (CA key deleted)"
  fi
  printf 'stranger leaf sha256: '
  openssl x509 -in stranger.pem -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1
fi
