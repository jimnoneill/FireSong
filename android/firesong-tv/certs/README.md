# The FireSong LAN CA in the TV app

Release builds trust the system CAs plus one extra root: `@raw/firesong_lan_ca`, which is `app/src/main/res/raw/firesong_lan_ca.pem`. That is the root of the PKI that serves the TV origin, Caddy `tls internal` in front of `NIGHTINGALE_BIND` (design §4).

## The committed file is a placeholder

`firesong_lan_ca.pem` in git is a self-signed CA, "FireSong LAN CA placeholder - replace before use". Its private key was destroyed when it was made, so it can sign nothing, and trusting it is harmless. It exists only so that `network_security_config.xml` always parses. A placeholder build will not trust your Caddy.

## Bundling the real root

Do not commit the real root. Pass it at build time instead:

```sh
# Caddy's root, on the host that runs Caddy (path depends on Caddy's data dir):
#   <caddy-data>/caddy/pki/authorities/local/root.crt
cd android/firesong-tv
./gradlew assembleRelease -Pfiresong.lanCa=/path/to/root.crt
# or set firesong.lanCa=... in the git-ignored firesong.local.properties
```

The build checks that the file is a PEM certificate and puts it in every variant in place of the placeholder. To check an APK:

```sh
unzip -p app/build/outputs/apk/release/app-release.apk res/raw/firesong_lan_ca.pem | openssl x509 -noout -subject -fingerprint -sha256
```

Use the **root**, not Caddy's intermediate: the intermediate is renewed about every 7 days, and leaf certificates about every 12 hours with new keys.

## Leaf pins (fallback only)

If a WebView ever ignores the trust anchor, `onReceivedSslError` can still proceed for the TV host when the leaf matches a pin:

- `firesong.leafPins=<64-hex cert SHA-256>,sha256/<base64 SPKI>` at build time, or
- `tools/tvctl configure --leaf-pin <pins>` on the installed app. Pins are bound to the URL's origin.

The app logs the SHA-256 and SPKI pin of every leaf it rejects (`tools/tvctl logcat | grep 'TLS error'`). Pin only a long-lived static leaf; Caddy's rotating internal leaves cannot be pinned this way. On the Cube's WebView (Chromium 138), spike S1 found the trust anchor honoured, so the fallback is not needed today.
