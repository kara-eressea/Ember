// Opt-in at-rest credential storage (M9, decisions.md §15). AES-256-GCM
// under the env-file CREDENTIALS_KEY; the blob is base64(iv ‖ tag ‖ ct).
// No key configured → the store is disabled: nothing saves, nothing loads;
// boot-resume.ts counts any rows a previous configuration left behind and
// reports them loudly (they still ride backups), and the Forget toggle can
// delete them without a key. Plaintext passwords still never touch logs or
// error paths — the vault hygiene rules apply here unchanged.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/index.js";
import { flistAccounts, flistCredentials } from "../../db/schema.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialStore {
  readonly #db: Db;
  readonly #key: Buffer | undefined;
  readonly #log: FastifyBaseLogger | undefined;

  constructor(options: { db: Db; key?: string; logger?: FastifyBaseLogger }) {
    this.#db = options.db;
    this.#key =
      options.key === undefined
        ? undefined
        : Buffer.from(options.key, "base64url");
    this.#log = options.logger;
  }

  /** Whether the server is configured to remember credentials at all. */
  get enabled(): boolean {
    return this.#key !== undefined;
  }

  async save(accountId: string, password: string): Promise<void> {
    const key = this.#requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(password, "utf8"),
      cipher.final(),
    ]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
    await this.#db
      .insert(flistCredentials)
      .values({ accountId, ciphertext: blob })
      .onConflictDoUpdate({
        target: flistCredentials.accountId,
        set: { ciphertext: blob, updatedAt: sql`now()` },
      });
  }

  async remove(accountId: string): Promise<void> {
    await this.#db
      .delete(flistCredentials)
      .where(eq(flistCredentials.accountId, accountId));
  }

  /** Account ids that have a stored credential (for list presentation). */
  async storedAccountIds(): Promise<Set<string>> {
    const rows = await this.#db
      .select({ accountId: flistCredentials.accountId })
      .from(flistCredentials);
    return new Set(rows.map((row) => row.accountId));
  }

  /**
   * Every stored credential, decrypted — the boot-resume path. A row that
   * fails to decrypt (rotated key, corrupt blob) is reported loudly and
   * skipped; its account simply needs a manual unlock like before M9.
   */
  async loadAll(): Promise<
    { accountId: string; accountName: string; password: string }[]
  > {
    if (!this.enabled) {
      return [];
    }
    const rows = await this.#db
      .select({
        accountId: flistCredentials.accountId,
        ciphertext: flistCredentials.ciphertext,
        accountName: flistAccounts.accountName,
      })
      .from(flistCredentials)
      .innerJoin(
        flistAccounts,
        eq(flistCredentials.accountId, flistAccounts.id),
      );
    const loaded: {
      accountId: string;
      accountName: string;
      password: string;
    }[] = [];
    for (const row of rows) {
      const password = this.#decrypt(row.ciphertext);
      if (password === undefined) {
        this.#log?.error(
          { accountId: row.accountId, accountName: row.accountName },
          "stored F-List credential failed to decrypt (rotated CREDENTIALS_KEY?) — the account needs a manual unlock",
        );
        continue;
      }
      loaded.push({ ...row, password });
    }
    return loaded;
  }

  #decrypt(blob: string): string | undefined {
    const key = this.#requireKey();
    try {
      const raw = Buffer.from(blob, "base64");
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const data = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      return undefined;
    }
  }

  #requireKey(): Buffer {
    if (this.#key === undefined) {
      throw new Error("credential store is disabled (no CREDENTIALS_KEY)");
    }
    return this.#key;
  }
}
