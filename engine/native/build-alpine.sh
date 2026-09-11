#!/bin/sh
# Run inside the matching-architecture Node Alpine image mounted at /work.
set -eu
apk add --no-cache build-base bash git autoconf automake libtool pkgconf perl python3 py3-lxml \
  gperf bison flex zip unzip gettext-dev linux-headers curl-dev openssl-dev nss-dev \
  libxml2-dev libxslt-dev fontconfig-dev freetype-dev harfbuzz-dev graphite2-dev cairo-dev \
  libjpeg-turbo-dev libpng-dev zlib-dev cups-dev tar patch which ninja nasm
export container=docker
git config --global --add safe.directory /work/.build/core
node scripts/checkout-core.mjs
node scripts/build-native.mjs --platform "$1" --jobs 4
node scripts/archive-engine.mjs "$1"
