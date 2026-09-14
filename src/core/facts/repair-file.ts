/**
 * Repair-only POSIX boundary. Retain no-follow directory and file handles
 * through the transaction. Mutations are one O_APPEND write to the verified
 * inode: no pathname rename, truncation, unlink, restoration or commit.
 * A platform lacking openat/O_NOFOLLOW refuses; there is no path fallback.
 */
import { dlopen } from 'bun:ffi';
import { constants, closeSync, fstatSync, fsyncSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Reject invalid UTF-8; retain a BOM rather than silently dropping it. */
export function strictUtf8(bytes: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('file is not round-trip UTF-8');
  return text;
}

export function openRepairFile(writeRoot: string, filePath: string, writable = false) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('repair requires POSIX no-follow handles');
  const rel = relative(resolve(writeRoot), resolve(filePath));
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error('repair target escapes source');
  // Only the registered root may use an OS alias (macOS /tmp). Descendants
  // are opened one at a time with O_NOFOLLOW, including the target file.
  const absolute = resolve(realpathSync(writeRoot), rel);
  const parts = dirname(absolute).split('/').filter(Boolean);
  // openat's variadic mode argument is deliberately absent: we NEVER create.
  const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    openat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
  });
  const dirs: number[] = [];
  let file = -1;
  const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const openAt = (parent: number, name: string, flags: number): number => {
    if (name.includes('\0')) throw new Error('NUL in repair path');
    const fd = lib.symbols.openat(parent, Buffer.from(`${name}\0`), flags);
    if (fd < 0) throw new Error(`no-follow open refused: ${name}`);
    return fd;
  };
  const close = () => {
    if (file >= 0) { closeSync(file); file = -1; }
    for (const fd of dirs.splice(0).reverse()) closeSync(fd);
    lib.close();
  };
  try {
    dirs.push(openSync('/', dirFlags));
    for (const part of parts) dirs.push(openAt(dirs[dirs.length - 1]!, part, dirFlags));
    const parent = dirs[dirs.length - 1]!;
    const name = basename(absolute);
    file = openAt(parent, name, (writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY)
      | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = fstatSync(file, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) throw new Error('repair requires a regular, singly-linked file');
    const read = () => {
      const size = Number(fstatSync(file).size);
      if (size > 64 * 1024 * 1024) throw new Error('repair file exceeds 64 MiB');
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const n = readSync(file, bytes, offset, size - offset, offset);
        if (!n) throw new Error('file changed during read');
        offset += n;
      }
      if (fstatSync(file).size !== size) throw new Error('file changed during read');
      return bytes;
    };
    const bytes = read();
    const body = strictUtf8(bytes);
    const checkLocation = () => {
      let current = openSync('/', dirFlags);
      try {
        for (let i = 0; i < parts.length; i++) {
          const next = openAt(current, parts[i]!, dirFlags);
          closeSync(current); current = next;
          const a = fstatSync(current, { bigint: true });
          const b = fstatSync(dirs[i + 1]!, { bigint: true });
          if (a.dev !== b.dev || a.ino !== b.ino) throw new Error('repair parent identity changed');
        }
        const candidate = openAt(current, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const st = fstatSync(candidate, { bigint: true });
          if (!st.isFile() || st.nlink !== 1n || st.dev !== identity.dev || st.ino !== identity.ino) throw new Error('repair file identity changed');
        } finally { closeSync(candidate); }
      } finally { closeSync(current); }
    };
    const check = () => {
      checkLocation();
      const st = fstatSync(file, { bigint: true });
      if (st.size !== identity.size || st.mtimeNs !== identity.mtimeNs || st.ctimeNs !== identity.ctimeNs || !read().equals(bytes)) {
        throw new Error('repair file changed');
      }
    };
    const verify = (text: string) => {
      checkLocation();
      if (!read().equals(Buffer.from(text, 'utf8'))) throw new Error('file changed after repair planning; manual review required');
    };
    const append = (text: string, beforeWrite?: () => void) => {
      if (!writable || !text.startsWith(body)) throw new Error('repair would require a file rewrite');
      check();
      beforeWrite?.(); // Test seam AFTER checks: the kernel still writes only our pinned inode.
      const suffix = Buffer.from(text.slice(body.length), 'utf8');
      if (writeSync(file, suffix, 0, suffix.length, null) !== suffix.length) throw new Error('partial repair append; manual review required');
      fsyncSync(file);
      verify(text);
    };
    return { bytes, body, check, verify, append, close };
  } catch (err) { close(); throw err; }
}
