export { REMOTE_PROTOCOL, RELAY_HOST, RELAY_PORT, RELAY_URL, RELAY_CERT_SHA256 } from './protocol.js'
export type { BindingView, ClientFrame, ClientRole, PairingQr, ServerFrame } from './protocol.js'
export { decodeClientFrame, decodePairingQr, decodeServerFrame, encodeFrame, encodePairingQr } from './protocol.js'
export { DESKTOP_PUSH_WHAT, REMOTE_POLICY, remoteRule } from './whitelist.js'
export type { RemotePolicy, RemoteRule } from './whitelist.js'
export { applyRemoteStream, createChatStreamGate, createStreamCoalescer, streamDelta } from './stream.js'
export type { RemoteStreamFrame, RemoteStreamIn, StreamFlush } from './stream.js'
export { openPlain, sealPlain } from './e2e.js'
export type { E2ePlain } from './e2e.js'
export { RelayLink } from './link.js'
export type { LinkEvent, RelayLinkOptions } from './link.js'
export {
  FIXTURE_PRIV,
  RemoteCipher,
  aadFor,
  authMessage,
  bootCipher,
  ed25519PublicKey,
  handshake,
  randomBytes,
  randomEd25519,
  randomX25519,
  referenceFixture,
  safetyCode,
  signAuth,
  verifyAuth,
  x25519PublicKey,
  b64ToBytes,
  bytesToB64,
  bytesToHex,
  hexToBytes,
} from './crypto.js'
export type { CryptoFixture, HandshakeInput, HandshakeResult } from './crypto.js'
