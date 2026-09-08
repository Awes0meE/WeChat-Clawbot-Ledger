import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, openSync, closeSync, readSync, writeSync, fstatSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

export async function encryptArchive(input, file, key, manifest) {
  if (key.length !== 32) throw new Error('Invalid backup key');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(manifest)));
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, iv);
    await pipeline(input, cipher, createWriteStream(file, { fd, autoClose: false, start: 12 }));
    writeSync(fd, cipher.getAuthTag(), 0, 16, fstatSync(fd).size);
  } finally { closeSync(fd); }
}

export async function decryptArchive(file, key, manifest, output = new Writable({ write(_chunk, _encoding, done) { done(); } })) {
  const fd = openSync(file, 'r');
  let size, iv = Buffer.alloc(12), tag = Buffer.alloc(16);
  try {
    size = fstatSync(fd).size;
    if (size < 29 || key.length !== 32) throw new Error('Invalid backup archive');
    readSync(fd, iv, 0, 12, 0); readSync(fd, tag, 0, 16, size - 16);
  } finally { closeSync(fd); }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(JSON.stringify(manifest))); decipher.setAuthTag(tag);
  await pipeline(createReadStream(file, { start: 12, end: size - 17 }), decipher, output);
}
