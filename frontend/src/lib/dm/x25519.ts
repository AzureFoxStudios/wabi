const P = (1n << 255n) - 19n
const P3 = P * 3n
const P4 = P * 4n
const A = 486662n
const A24 = (A - 2n) / 4n  // a24 = 121665

function mod(a: bigint): bigint {
  const r = a % P
  return r >= 0n ? r : r + P
}

function mul(a: bigint, b: bigint): bigint {
  return mod(a * b)
}

function add(a: bigint, b: bigint): bigint {
  return mod(a + b)
}

function sub(a: bigint, b: bigint): bigint {
  return mod(a - b)
}

function inv(a: bigint): bigint {
  let t = a
  for (let i = 253; i >= 0; i--) {
    t = mul(t, t)
    if (i !== 2 && i !== 4) t = mul(t, a)
  }
  return t
}

function toBigint(bytes: Uint8Array): bigint {
  let r = 0n
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]!)
  return r
}

function toBytes(n: bigint, len: number): Uint8Array {
  const b = new Uint8Array(len)
  for (let i = 0; i < len; i++) { b[i] = Number(n & 0xffn); n >>= 8n }
  return b
}

function clamp(s: Uint8Array): Uint8Array {
  const c = new Uint8Array(s)
  c[0] &= 248
  c[31] &= 127
  c[31] |= 64
  return c
}

function decodeU(bytes: Uint8Array): bigint {
  const u = new Uint8Array(bytes)
  u[31] &= 127
  return toBigint(u)
}

export function x25519(scalar: Uint8Array, point: Uint8Array): Uint8Array {
  const k = clamp(scalar)
  const u = decodeU(point)

  let x1 = u
  let x2 = 1n
  let z2 = 0n
  let x3 = u
  let z3 = 1n
  let swap = 0

  for (let t = 254; t >= 0; t--) {
    const kt = (k[t >> 3]! >> (t & 7)) & 1
    swap ^= kt
    if (swap) {
      let tmp = x2; x2 = x3; x3 = tmp
      tmp = z2; z2 = z3; z3 = tmp
    }
    swap = kt

    const A = add(x2, z2)
    const AA = mul(A, A)
    const B = sub(x2, z2)
    const BB = mul(B, B)
    const E = sub(AA, BB)
    const C = add(x3, z3)
    const D = sub(x3, z3)
    const DA = mul(D, A)
    const CB = mul(C, B)
    x3 = add(DA, CB)
    z3 = mul(x3, x3)
    x3 = mul(x3, x3)
    z3 = mul(x1, mul(sub(DA, CB), sub(DA, CB)))

    x2 = mul(AA, BB)
    z2 = mul(E, add(AA, mul(E, A24)))
  }

  if (swap) { let tmp = x2; x2 = x3; x3 = tmp; tmp = z2; z2 = z3; z3 = tmp }
  return toBytes(mul(x2, inv(z2)), 32)
}

export function computePublicKey(privateKey: Uint8Array): Uint8Array {
  const BASE_POINT = new Uint8Array(32)
  BASE_POINT[0] = 9
  return x25519(privateKey, BASE_POINT)
}
