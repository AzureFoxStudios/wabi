export interface PreKeyBundle {
  identityKey: CryptoKey
  signedPreKey: CryptoKey
  preKeySignature: ArrayBuffer
  oneTimePreKey?: CryptoKey
  deviceId: string
}

export interface X3DHOutput {
  rootKey: ArrayBuffer
  theirEphemeralKey: CryptoKey
  ourEphemeralKey: CryptoKey
}

export interface RatchetSession {
  conversationId: string
  rootKey: ArrayBuffer
  sendingChain?: ArrayBuffer
  receivingChain?: ArrayBuffer
  DHs: CryptoKey
  DHr?: CryptoKey
  Ns: number
  Nr: number
  PN: number
  deviceId: string
  peerDeviceId: string
  peerPublicKeyB64: string
}

export interface EncryptedMessage {
  version: number
  ciphertext: ArrayBuffer
  nonce: Uint8Array
  senderDeviceId: string
  RatchetDHr?: ArrayBuffer
  PN?: number
  Ns?: number
}

function toAB(input: Uint8Array | ArrayBuffer): ArrayBuffer {
	if (input instanceof ArrayBuffer) return input
	const u8 = input as Uint8Array
	const copy = new Uint8Array(u8.byteLength)
	copy.set(u8)
	return copy.buffer as ArrayBuffer
}

function concat(...buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((s, b) => s + b.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const b of buffers) {
    result.set(new Uint8Array(b), offset)
    offset += b.byteLength
  }
  return result.buffer
}

async function hkdfDerive(salt: ArrayBuffer, input: ArrayBuffer, info: string, length: number): Promise<{ key: ArrayBuffer; nextSalt: ArrayBuffer }> {
  const key = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits'])
  const output = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: new TextEncoder().encode(info) },
    key,
    length
  )
  const splitPoint = 256 / 8
  return {
    key: output.slice(0, splitPoint),
    nextSalt: output.slice(splitPoint)
  }
}

async function KDF_CK(ck: ArrayBuffer): Promise<{ mk: ArrayBuffer; nextCk: ArrayBuffer }> {
  const salt = new Uint8Array(32)
  const key = await crypto.subtle.importKey('raw', ck, 'HKDF', false, ['deriveBits'])
  const output = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('wabi-ratchet-chain') },
    key,
    512
  )
  return { mk: output.slice(0, 32), nextCk: output.slice(32) }
}

export async function x3dhInitiate(
  ourIdentity: CryptoKey,
  theirBundle: PreKeyBundle
): Promise<X3DHOutput> {
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'X25519' },
    false,
    ['deriveBits', 'deriveKey']
  ) as CryptoKeyPair
  let sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirBundle.identityKey },
    ourIdentity,
    256
  )
  const dh1 = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirBundle.signedPreKey },
    ourIdentity,
    256
  )
  sharedSecret = concat(sharedSecret, dh1)
  const dh2 = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirBundle.identityKey },
    ephemeralKeyPair.privateKey,
    256
  )
  sharedSecret = concat(sharedSecret, dh2)
  if (theirBundle.oneTimePreKey) {
    const dh3 = await crypto.subtle.deriveBits(
      { name: 'X25519', public: theirBundle.oneTimePreKey },
      ephemeralKeyPair.privateKey,
      256
    )
    sharedSecret = concat(sharedSecret, dh3)
  }
  const rootKey = await crypto.subtle.digest('SHA-256', sharedSecret)
  return { rootKey, theirEphemeralKey: ephemeralKeyPair.publicKey, ourEphemeralKey: ephemeralKeyPair.privateKey }
}

export async function x3dhRespond(
  ourIdentity: CryptoKey,
  ourSignedPreKey: CryptoKey,
  oneTimePreKey: CryptoKey | undefined,
  theirIdentityKey: CryptoKey,
  theirEphemeralKey: CryptoKey
): Promise<ArrayBuffer> {
  let sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirIdentityKey },
    ourIdentity,
    256
  )
  const dh1 = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirIdentityKey },
    ourSignedPreKey,
    256
  )
  sharedSecret = concat(sharedSecret, dh1)
  const dh2 = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirEphemeralKey },
    ourIdentity,
    256
  )
  sharedSecret = concat(sharedSecret, dh2)
  if (oneTimePreKey) {
    const dh3 = await crypto.subtle.deriveBits(
      { name: 'X25519', public: theirEphemeralKey },
      oneTimePreKey,
      256
    )
    sharedSecret = concat(sharedSecret, dh3)
  }
  return crypto.subtle.digest('SHA-256', sharedSecret)
}

export async function ratchetInit(session: RatchetSession, theirDHPublicKey: CryptoKey): Promise<RatchetSession> {
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirDHPublicKey },
    session.DHs,
    256
  )
  const recvOutput = await hkdfDerive(session.rootKey, sharedSecret, 'wabi-ratchet-recv', 512)
  const rootKey = recvOutput.nextSalt
  const receivingChain = recvOutput.key
  const sendSharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirDHPublicKey },
    session.DHs,
    256
  )
  const sendOutput = await hkdfDerive(rootKey, sendSharedSecret, 'wabi-ratchet-send', 512)
  session.rootKey = sendOutput.nextSalt
  session.sendingChain = sendOutput.key
  session.DHr = theirDHPublicKey
  session.Nr = 0
  session.Ns = 0
  session.PN = session.PN
  return session
}

export function generateNewDHKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits', 'deriveKey']) as Promise<CryptoKeyPair>
}

export async function encryptMessage(
  session: RatchetSession,
  plaintext: string,
  aad: ArrayBuffer | Uint8Array
): Promise<{ message: EncryptedMessage; session: RatchetSession }> {
  if (!session.sendingChain) {
    session.sendingChain = await crypto.subtle.deriveBits(
      { name: 'X25519', public: session.DHr! },
      session.DHs,
      256
    )
  }
  const { mk, nextCk } = await await KDF_CK(session.sendingChain)
  session.sendingChain = nextCk
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await crypto.subtle.importKey('raw', mk, 'AES-GCM', false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: toAB(aad) },
    aesKey,
    new TextEncoder().encode(plaintext)
  )
  const message: EncryptedMessage = {
    version: 1,
    ciphertext,
    nonce,
    senderDeviceId: session.deviceId,
    Ns: session.Ns,
    PN: session.PN
  }
  session.Ns++
  return { message, session }
}

export async function decryptMessage(
  session: RatchetSession,
  message: EncryptedMessage,
  aad: ArrayBuffer | Uint8Array
): Promise<{ plaintext: string; session: RatchetSession }> {
  if (message.RatchetDHr) {
    const dhKey = await crypto.subtle.importKey(
      'raw', message.RatchetDHr, { name: 'X25519' }, false, []
    )
    session = await ratchetInit(session, dhKey)
  }
  if (message.Ns !== undefined && message.Ns < session.Nr) {
    let ck = session.receivingChain!
    const skipCount = session.Nr - message.Ns
    for (let i = 0; i < skipCount; i++) {
      const result = await KDF_CK(ck)
      ck = result.nextCk
    }
    session.receivingChain = ck
    const { mk } = await KDF_CK(session.receivingChain)
    const aesKey = await crypto.subtle.importKey('raw', mk, 'AES-GCM', false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toAB(message.nonce), additionalData: toAB(aad) },
      aesKey,
      message.ciphertext
    );
    session.Nr++
    return { plaintext: new TextDecoder().decode(plaintext), session }
  }
  const { mk, nextCk } = await KDF_CK(session.receivingChain!)
  session.receivingChain = nextCk
  const aesKey = await crypto.subtle.importKey('raw', mk, 'AES-GCM', false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toAB(message.nonce), additionalData: toAB(aad) },
    aesKey,
    message.ciphertext
  )
  session.Nr++
  return { plaintext: new TextDecoder().decode(plaintext), session }
}

export function serializeSession(session: RatchetSession): string {
  return JSON.stringify({
    conversationId: session.conversationId,
    rootKey: Array.from(new Uint8Array(session.rootKey)),
    sendingChain: session.sendingChain ? Array.from(new Uint8Array(session.sendingChain)) : null,
    receivingChain: session.receivingChain ? Array.from(new Uint8Array(session.receivingChain)) : null,
    DHs: session.DHs,
    DHr: session.DHr,
    Ns: session.Ns,
    Nr: session.Nr,
    PN: session.PN,
    deviceId: session.deviceId,
    peerDeviceId: session.peerDeviceId,
    peerPublicKeyB64: session.peerPublicKeyB64
  })
}
