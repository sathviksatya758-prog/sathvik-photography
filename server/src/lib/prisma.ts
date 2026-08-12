import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/env';

// Single shared instance — reused across hot reloads in dev via globalThis
// so `tsx watch` doesn't exhaust the Postgres connection pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProd ? ['error', 'warn'] : ['error', 'warn']
  });

if (!isProd) globalForPrisma.prisma = prisma;
