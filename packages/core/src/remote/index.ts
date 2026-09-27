export { REMOTE_PROTOCOL, RELAY_HOST, RELAY_PORT, RELAY_URL, RELAY_CERT_SHA256 } from './protocol.js'
export type { BindingView, ClientFrame, ClientRole, ServerFrame } from './protocol.js'
export { decodeClientFrame, decodeServerFrame, encodeFrame } from './protocol.js'
export { DESKTOP_PUSH_WHAT, REMOTE_POLICY, remoteRule } from './whitelist.js'
export type { RemotePolicy, RemoteRule } from './whitelist.js'
export { createStreamCoalescer, streamDelta } from './stream.js'
export type { StreamFlush } from './stream.js'
export {
  FIXTURE_PRIV,
  RemoteCipher,
  aadFor,
  authMessage,
  handshake,
  randomBytes,
  randomEd25519,
  randomX25519,
  referenceFixture,
  safetyCode,
  signAuth,
  verifyAuth,
  bytesToB64,
  bytesToHex,
  hexToBytes,
} from './crypto.js'
export type { CryptoFixture, HandshakeInput, HandshakeResult } from './crypto.js'
