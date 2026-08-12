#!/bin/sh
set -e

# Applies committed migrations (including the hand-written pgvector/
# HNSW/search-function additions at the bottom of 000_init) before the
# app or worker process starts. Safe to run on every boot — Prisma
# tracks which migrations have already applied.
echo "Running database migrations..."
npx prisma migrate deploy

exec "$@"
