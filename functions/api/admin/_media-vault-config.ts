export interface MediaVaultConfig {
  token: string;
  adminChatId: string;
  vaultChatId: string;
  botUsername: string;
  vaultTitle: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesToHex = (value: Uint8Array) => [...value].map((x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (value: string) => new Uint8Array((value.match(/.{2}/g) || []).map((x) => parseInt(x, 16)));

const deriveKey = async (secret: string) => {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("masenet-media-vault-config-v1"), info: encoder.encode("telegram-bot-credentials") },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
};

export const ensureMediaVaultConfigTable = async (db: D1Database) => {
  await db.prepare(`CREATE TABLE IF NOT EXISTS telegram_media_vault_config (
    id INTEGER PRIMARY KEY CHECK (id=1),
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    bot_username TEXT NOT NULL,
    vault_title TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
};

export const saveMediaVaultConfig = async (db: D1Database, secret: string, config: MediaVaultConfig) => {
  await ensureMediaVaultConfigTable(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(config)));
  await db.prepare(`INSERT INTO telegram_media_vault_config (id,ciphertext,iv,bot_username,vault_title,updated_at)
    VALUES (1,?,?,?, ?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,bot_username=excluded.bot_username,vault_title=excluded.vault_title,updated_at=datetime('now')`)
    .bind(bytesToHex(new Uint8Array(encrypted)), bytesToHex(iv), config.botUsername, config.vaultTitle).run();
};

export const loadMediaVaultConfig = async (db: D1Database, secret: string): Promise<MediaVaultConfig | null> => {
  await ensureMediaVaultConfigTable(db);
  const row = await db.prepare("SELECT ciphertext,iv FROM telegram_media_vault_config WHERE id=1")
    .first<{ ciphertext: string; iv: string }>();
  if (!row?.ciphertext || !row.iv) return null;
  try {
    const key = await deriveKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(row.iv) }, key, hexToBytes(row.ciphertext));
    const value = JSON.parse(decoder.decode(plain)) as MediaVaultConfig;
    if (!value.token || !value.adminChatId || !value.vaultChatId) return null;
    return value;
  } catch {
    return null;
  }
};
