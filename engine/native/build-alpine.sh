#!/bin/sh
# Run inside the matching-architecture Node Alpine image mounted at /work.
set -eu
apk add --no-cache build-base bash coreutils findutils diffutils grep sed git autoconf automake libtool pkgconf perl python3 py3-lxml \
  gperf bison flex zip unzip gettext-dev linux-headers curl curl-dev openssl-dev nss-dev \
  libxml2-dev libxslt-dev fontconfig-dev freetype-dev harfbuzz-dev graphite2-dev cairo-dev \
  libjpeg-turbo-dev libpng-dev zlib-dev cups-dev tar patch which ninja nasm font-dejavu
export container=docker
git config --global --add safe.directory /work/.build/core
node scripts/checkout-core.mjs
if [ "${LIBREOFFICE_REUSE_CORE:-false}" = true ]; then
  tar -xzf ".build/reused-core/core-payload-$1.tar.gz"
  node scripts/rebuild-native-helper.mjs "$1"
else
  node scripts/build-native.mjs --platform "$1" --jobs 4
fi
node scripts/archive-engine.mjs "$1"
npm install --global --ignore-scripts pnpm@11.7.0
pnpm install --ignore-scripts --frozen-lockfile
LIBREOFFICE_RUNTIME_ENTRY="$PWD/packages/entry/src/index.js" LIBREOFFICE_RUNTIME_EXPECT_BACKEND=native \
  node --test test/runtime-engine.test.mjs
