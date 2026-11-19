import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { findWorkspaceRoot } from '@pms/config';
import { storedFiles, type DbOrTx, type StoredFileKind } from '@pms/db';
import { decryptBytes, encryptBytes, randomToken, sha256Hex } from './crypto';
import { notFound, validationError } from './errors';

export type StoredFileRow = typeof storedFiles.$inferSelect;

/** Where file contents live. The database holds what each file is; the store holds only opaque bytes. */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Files on a local or mounted disk. */
export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(directory: string) {
    // A relative directory is taken from the workspace root, so the API and the worker agree on it.
    this.root = resolve(findWorkspaceRoot() ?? process.cwd(), directory);
  }

  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Refusing a file key outside the store');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: 0o600 });
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** Keeps files in memory. For tests. */
export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    this.files.set(key, data);
  }

  async get(key: string): Promise<Buffer> {
    const data = this.files.get(key);
    if (!data) throw new Error(`No such file: ${key}`);
    return data;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** What an upload really is, judged from its first bytes rather than from what the sender says it is. */
export function sniffContentType(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

export interface NewFile {
  orgId: string;
  propertyId?: string | null;
  reservationId?: string | null;
  guestId?: string | null;
  kind: StoredFileKind;
  fileName: string;
  data: Buffer;
  uploadedBy?: string | null;
  /** When the retention job should remove it. */
  deleteAfter?: Date | null;
}

/**
 * Keeps a file: encrypted, under a random key, with its details in the
 * database. Only photos and PDFs are accepted, and the type is taken from
 * the content.
 */
export async function storeFile(
  db: DbOrTx,
  store: FileStore,
  input: NewFile,
): Promise<StoredFileRow> {
  if (input.data.length === 0) throw validationError('The file is empty');
  if (input.data.length > MAX_FILE_BYTES) {
    throw validationError('The file is larger than 8 MB');
  }
  const contentType = sniffContentType(input.data);
  if (!contentType) {
    throw validationError('Only JPEG, PNG and WebP photos and PDF files are accepted');
  }
  const storageKey = join(input.orgId, input.kind, `${randomToken(24)}.bin`);
  await store.put(storageKey, encryptBytes(input.data));
  try {
    const [row] = await db
      .insert(storedFiles)
      .values({
        orgId: input.orgId,
        propertyId: input.propertyId ?? null,
        reservationId: input.reservationId ?? null,
        guestId: input.guestId ?? null,
        kind: input.kind,
        storageKey,
        // Only the last part, without anything that could be taken for a path.
        fileName:
          input.fileName
            .split(/[\\/]/)
            .pop()!
            .replace(/[^\w.\- ()]/g, '_')
            .slice(0, 120) || 'file',
        contentType,
        size: input.data.length,
        sha256: sha256Hex(input.data),
        encrypted: true,
        uploadedBy: input.uploadedBy ?? null,
        deleteAfter: input.deleteAfter ?? null,
      })
      .returning();
    return row!;
  } catch (err) {
    await store.delete(storageKey).catch(() => undefined);
    throw err;
  }
}

/** Reads a file back, decrypted. The caller has already decided the reader may see it. */
export async function readStoredFile(
  db: DbOrTx,
  store: FileStore,
  orgId: string,
  fileId: string,
): Promise<{ file: StoredFileRow; data: Buffer }> {
  const [file] = await db
    .select()
    .from(storedFiles)
    .where(
      and(eq(storedFiles.id, fileId), eq(storedFiles.orgId, orgId), isNull(storedFiles.deletedAt)),
    );
  if (!file) throw notFound('File', fileId);
  const raw = await store.get(file.storageKey);
  return { file, data: file.encrypted ? decryptBytes(raw) : raw };
}

export async function deleteStoredFile(
  db: DbOrTx,
  store: FileStore,
  fileId: string,
): Promise<void> {
  const [file] = await db
    .update(storedFiles)
    .set({ deletedAt: new Date() })
    .where(and(eq(storedFiles.id, fileId), isNull(storedFiles.deletedAt)))
    .returning();
  if (file) await store.delete(file.storageKey);
}

/** Removes files whose time is up. Returns how many. Run by the worker. */
export async function purgeExpiredFiles(
  db: DbOrTx,
  store: FileStore,
  now: Date = new Date(),
  limit = 500,
): Promise<number> {
  const due = await db
    .select({ id: storedFiles.id })
    .from(storedFiles)
    .where(
      and(
        isNull(storedFiles.deletedAt),
        sql`${storedFiles.deleteAfter} IS NOT NULL`,
        lte(storedFiles.deleteAfter, now),
      ),
    )
    .limit(limit);
  for (const { id } of due) await deleteStoredFile(db, store, id);
  return due.length;
}
