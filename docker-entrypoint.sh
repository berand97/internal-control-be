#!/bin/sh
set -eu

STORAGE_ROOT="${STORAGE_PROJECT_PATH:-/data/storage}"
mkdir -p "$STORAGE_ROOT/generated" "$STORAGE_ROOT/attachments" "$STORAGE_ROOT/templates"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$STORAGE_ROOT"
  if [ ! -e /app/storage ]; then
    ln -s "$STORAGE_ROOT" /app/storage
    chown -h node:node /app/storage
  fi
  exec runuser -u node -- "$0" "$@"
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Aplicando migraciones de base de datos..."
  node ./node_modules/typeorm/cli.js migration:run -d ./dist/database/data-source.js
fi

exec node dist/main.js
