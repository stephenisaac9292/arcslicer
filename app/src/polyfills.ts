import { Buffer } from 'buffer';

type GlobalWithNode = typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

const nodeLikeGlobal = globalThis as GlobalWithNode;

if (!nodeLikeGlobal.global) {
  nodeLikeGlobal.global = globalThis;
}

if (!nodeLikeGlobal.Buffer) {
  nodeLikeGlobal.Buffer = Buffer;
}
