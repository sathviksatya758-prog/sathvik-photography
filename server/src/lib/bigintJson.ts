// Prisma returns BigInt for BigInt/BigSerial columns (photo.bytes,
// renditions.id, analytics ids, etc). JSON.stringify throws on BigInt
// by default — this makes res.json() work everywhere without every
// handler remembering to call .toString() itself. Import once, first,
// from the app entrypoint.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

export {};
