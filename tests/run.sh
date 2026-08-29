#!/bin/sh
# Teste patches/routes.js hors conteneur.
#
# routes.js importe ses voisins en relatif (../subprocess/manager.js,
# ../adapter/*.js), tels qu'ils existent dans dist/ du paquet npm. On reconstruit
# donc cette arborescence dans un dossier temporaire, avec des doublures qui
# simulent la CLI Claude Code au lieu de la lancer pour de vrai.
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/dist/server" "$WORK/dist/subprocess" "$WORK/dist/adapter"
cp "$ROOT/patches/routes.js" "$WORK/dist/server/routes.js"
cp "$ROOT/tests/stubs/subprocess/manager.js" "$WORK/dist/subprocess/manager.js"
cp "$ROOT/tests/stubs/adapter/openai-to-cli.js" "$WORK/dist/adapter/openai-to-cli.js"
cp "$ROOT/tests/stubs/adapter/cli-to-openai.js" "$WORK/dist/adapter/cli-to-openai.js"
cp -R "$ROOT/tests/stubs/node_modules" "$WORK/node_modules"
cp "$ROOT/tests/routes.test.mjs" "$WORK/test.mjs"
printf '{"name":"routes-test","type":"module","version":"1.0.0"}\n' > "$WORK/package.json"

# Delais ecrases pour que la suite reste instantanee.
cd "$WORK" && PROXY_RETRY_DELAYS_MS=1,1,1 node test.mjs
