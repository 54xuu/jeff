import { DatabaseSync } from 'node:sqlite'

export interface PeerRow {
  id: string
  role: 'desktop' | 'app'
  sign_pub: string
  x25519_pub: string
  name: string
}

export interface BindingRow {
  desktop_id: string
  app_id: string
  created_at: number
}

export interface PairingRow {
  token: string
  desktop_id: string
  expires_at: number
  app_id: string
  app_name: string
  app_sign_pub: string
  app_x25519: string
}

export class Store {
  private db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peer (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        sign_pub TEXT NOT NULL,
        x25519_pub TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS binding (
        desktop_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS binding_app ON binding(app_id);
      CREATE TABLE IF NOT EXISTS pairing (
        token TEXT PRIMARY KEY,
        desktop_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        app_id TEXT NOT NULL DEFAULT '',
        app_name TEXT NOT NULL DEFAULT '',
        app_sign_pub TEXT NOT NULL DEFAULT '',
        app_x25519 TEXT NOT NULL DEFAULT ''
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  getPeer(id: string): PeerRow | undefined {
    return this.db.prepare('SELECT id, role, sign_pub, x25519_pub, name FROM peer WHERE id = ?').get(id) as PeerRow | undefined
  }

  upsertPeer(row: PeerRow, now: number): void {
    const cur = this.getPeer(row.id)
    if (!cur) {
      this.db.prepare(
        'INSERT INTO peer (id, role, sign_pub, x25519_pub, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.role, row.sign_pub, row.x25519_pub, row.name, now, now)
      return
    }
    this.db.prepare('UPDATE peer SET x25519_pub = ?, name = ?, last_seen_at = ? WHERE id = ?').run(
      row.x25519_pub || cur.x25519_pub,
      row.name || cur.name,
      now,
      row.id,
    )
  }

  touch(id: string, now: number): void {
    this.db.prepare('UPDATE peer SET last_seen_at = ? WHERE id = ?').run(now, id)
  }

  setX25519(id: string, pub: string, name: string, now: number): void {
    this.db.prepare('UPDATE peer SET x25519_pub = ?, name = ?, last_seen_at = ? WHERE id = ?').run(pub, name, now, id)
  }

  bindingByDesktop(desktopId: string): BindingRow | undefined {
    return this.db.prepare('SELECT desktop_id, app_id, created_at FROM binding WHERE desktop_id = ?').get(desktopId) as BindingRow | undefined
  }

  bindingsByApp(appId: string): BindingRow[] {
    return this.db.prepare('SELECT desktop_id, app_id, created_at FROM binding WHERE app_id = ?').all(appId) as unknown as BindingRow[]
  }

  upsertBinding(desktopId: string, appId: string, now: number): void {
    this.db.prepare(
      'INSERT INTO binding (desktop_id, app_id, created_at) VALUES (?, ?, ?) ON CONFLICT(desktop_id) DO UPDATE SET app_id = excluded.app_id, created_at = excluded.created_at',
    ).run(desktopId, appId, now)
  }

  deleteBinding(desktopId: string): void {
    this.db.prepare('DELETE FROM binding WHERE desktop_id = ?').run(desktopId)
  }

  deleteBindingsForApp(appId: string, desktopId: string): void {
    this.db.prepare('DELETE FROM binding WHERE app_id = ? AND desktop_id = ?').run(appId, desktopId)
  }

  putPairing(token: string, desktopId: string, expiresAt: number): void {
    this.db.prepare('DELETE FROM pairing WHERE desktop_id = ?').run(desktopId)
    this.db.prepare(
      'INSERT INTO pairing (token, desktop_id, expires_at) VALUES (?, ?, ?)',
    ).run(token, desktopId, expiresAt)
  }

  getPairing(token: string): PairingRow | undefined {
    return this.db.prepare(
      'SELECT token, desktop_id, expires_at, app_id, app_name, app_sign_pub, app_x25519 FROM pairing WHERE token = ?',
    ).get(token) as PairingRow | undefined
  }

  claimPairing(token: string, appId: string, appName: string, signPub: string, x25519: string): void {
    this.db.prepare(
      'UPDATE pairing SET app_id = ?, app_name = ?, app_sign_pub = ?, app_x25519 = ? WHERE token = ?',
    ).run(appId, appName, signPub, x25519, token)
  }

  deletePairing(token: string): void {
    this.db.prepare('DELETE FROM pairing WHERE token = ?').run(token)
  }
}
