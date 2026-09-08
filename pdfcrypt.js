'use strict';
/* global PDFLib */
/*
 * PDF Standard Security Handler — password protection and password removal.
 *
 * Writing:  RC4 128-bit (V2/R3), AES-128 (V4/R4), AES-256 (V5/R6).
 * Reading:  the same three, as long as the file's objects can be re-parsed
 *           by pdf-lib (see removePassword for the fallback path).
 *
 * Everything runs locally; no key or password ever leaves the page.
 */
(function (root) {

const { PDFDocument, PDFName, PDFString, PDFHexString, PDFRawStream, PDFArray,
        PDFDict, PDFRef, PDFNumber, PDFBool } = PDFLib;

/* ------------------------------------------------------------------ *
 * Small primitives
 * ------------------------------------------------------------------ */

const PAD = new Uint8Array([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56,
  0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

function concat(list) {
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function sameBytes(a, b, len) {
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---- MD5 (RFC 1321), needed for revisions 2-4 -------------------- */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

function md5(input) {
  const len = input.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true); ov.setInt32(4, b0, true);
  ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
  return out;
}

/* ---- RC4 --------------------------------------------------------- */

function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

/* ---- AES via WebCrypto ------------------------------------------- */

function importAesKey(raw, usages) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, usages);
}

// AES-CBC with PKCS#7 padding, which is what the PDF spec prescribes for
// AESV2 and AESV3 strings and streams.
async function aesCbcEncrypt(keyBytes, iv, data) {
  const key = await importAesKey(keyBytes, ['encrypt']);
  const buf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data);
  return new Uint8Array(buf);
}

async function aesCbcDecrypt(keyBytes, iv, data) {
  const key = await importAesKey(keyBytes, ['decrypt']);
  const buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
  return new Uint8Array(buf);
}

// AES-CBC without padding. WebCrypto always appends one padding block, so we
// encrypt and drop that trailing block; CBC is block-chained, the rest matches.
async function aesCbcEncryptNoPad(keyBytes, iv, data) {
  const full = await aesCbcEncrypt(keyBytes, iv, data);
  return full.slice(0, data.length);
}

// Inverse of the above: synthesise the ciphertext of a full padding block so
// WebCrypto's padding check passes, then strip it back off.
async function aesCbcDecryptNoPad(keyBytes, iv, data) {
  if (data.length === 0) return new Uint8Array(0);
  const lastBlock = data.slice(data.length - 16);
  const padBlock = new Uint8Array(16).fill(16);
  const tail = await aesCbcEncrypt(keyBytes, lastBlock, padBlock);
  const withPad = concat([data, tail.slice(0, 16)]);
  const plain = await aesCbcDecrypt(keyBytes, iv, withPad);
  return plain.slice(0, data.length);
}

async function sha2(bits, data) {
  const alg = bits === 256 ? 'SHA-256' : bits === 384 ? 'SHA-384' : 'SHA-512';
  return new Uint8Array(await crypto.subtle.digest(alg, data));
}

/* ------------------------------------------------------------------ *
 * Permission flags
 * ------------------------------------------------------------------ */

const PERM_BITS = {
  print: 4,           // bit 3
  modify: 8,          // bit 4
  copy: 16,           // bit 5
  annotate: 32,       // bit 6
  fillForms: 256,     // bit 9
  accessibility: 512, // bit 10
  assemble: 1024,     // bit 11
  printHighRes: 2048  // bit 12
};

function permissionsToP(perms) {
  // Bits 1-2 are reserved and must be 0; bits we do not control stay 1.
  let p = -1 & ~3;
  for (const key of Object.keys(PERM_BITS)) {
    if (perms && perms[key] === false) p &= ~PERM_BITS[key];
  }
  return p | 0;
}

function pToPermissions(p) {
  const out = {};
  for (const key of Object.keys(PERM_BITS)) out[key] = (p & PERM_BITS[key]) !== 0;
  return out;
}

/* ------------------------------------------------------------------ *
 * Key derivation
 * ------------------------------------------------------------------ */

function padPassword(pwBytes) {
  const out = new Uint8Array(32);
  const n = Math.min(32, pwBytes.length);
  out.set(pwBytes.subarray(0, n), 0);
  out.set(PAD.subarray(0, 32 - n), n);
  return out;
}

function int32le(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v | 0, true);
  return b;
}

// Algorithm 2 — file encryption key for revisions 2-4.
function computeKeyR234(passwordBytes, O, P, idFirst, keyLenBytes, revision, encryptMetadata) {
  const parts = [padPassword(passwordBytes), O.subarray(0, 32), int32le(P), idFirst];
  if (revision >= 4 && !encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  let hash = md5(concat(parts));
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, keyLenBytes));
  }
  return hash.slice(0, keyLenBytes);
}

// Algorithm 3 — the /O entry for revisions 2-4.
function computeO(ownerPwBytes, userPwBytes, keyLenBytes, revision) {
  let hash = md5(padPassword(ownerPwBytes.length ? ownerPwBytes : userPwBytes));
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash);
  }
  const rc4Key = hash.slice(0, revision === 2 ? 5 : keyLenBytes);
  let data = padPassword(userPwBytes);
  data = rc4(rc4Key, data);
  if (revision >= 3) {
    const tmp = new Uint8Array(rc4Key.length);
    for (let i = 1; i <= 19; i++) {
      for (let k = 0; k < rc4Key.length; k++) tmp[k] = rc4Key[k] ^ i;
      data = rc4(tmp, data);
    }
  }
  return data;
}

// Algorithms 4 and 5 — the /U entry for revisions 2-4.
function computeU(key, idFirst, revision) {
  if (revision === 2) return rc4(key, PAD);
  let data = md5(concat([PAD, idFirst]));
  data = rc4(key, data);
  const tmp = new Uint8Array(key.length);
  for (let i = 1; i <= 19; i++) {
    for (let k = 0; k < key.length; k++) tmp[k] = key[k] ^ i;
    data = rc4(tmp, data);
  }
  return concat([data, new Uint8Array(16)]);
}

// Algorithm 2.B — the revision 6 hardened password hash.
async function hash2B(passwordBytes, salt, userData, revision) {
  let K = await sha2(256, concat([passwordBytes, salt, userData]));
  if (revision === 5) return K;
  let round = 0;
  for (;;) {
    const seq = concat([passwordBytes, K, userData]);
    const K1 = new Uint8Array(seq.length * 64);
    for (let i = 0; i < 64; i++) K1.set(seq, i * seq.length);
    const E = await aesCbcEncryptNoPad(K.slice(0, 16), K.slice(16, 32), K1);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += E[i];
    const mod = sum % 3;
    K = await sha2(mod === 0 ? 256 : mod === 1 ? 384 : 512, E);
    round++;
    if (round >= 64 && E[E.length - 1] <= round - 32) break;
  }
  return K.slice(0, 32);
}

/* ------------------------------------------------------------------ *
 * Per-object keys and object-level encryption
 * ------------------------------------------------------------------ */

function objectKey(fileKey, num, gen, isAes) {
  const parts = [
    fileKey,
    new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255])
  ];
  if (isAes) parts.push(new Uint8Array([0x73, 0x41, 0x6c, 0x54])); // "sAlT"
  return md5(concat(parts)).slice(0, Math.min(fileKey.length + 5, 16));
}

/*
 * A cipher bound to one document. `forObject` returns encrypt/decrypt closures
 * for a given object and generation number.
 */
function makeCipher(scheme, fileKey) {
  const isAes = scheme !== 'rc4';
  const v5 = scheme === 'aes256';
  return {
    forObject(num, gen) {
      const key = v5 ? fileKey : objectKey(fileKey, num, gen, isAes);
      if (!isAes) {
        return {
          encrypt: (data) => Promise.resolve(rc4(key, data)),
          decrypt: (data) => Promise.resolve(rc4(key, data))
        };
      }
      return {
        encrypt: async (data) => {
          const iv = randomBytes(16);
          return concat([iv, await aesCbcEncrypt(key, iv, data)]);
        },
        decrypt: async (data) => {
          if (data.length === 0) return data;
          if (data.length <= 16 || (data.length - 16) % 16 !== 0) {
            throw new Error('Encrypted data has an unexpected length.');
          }
          return aesCbcDecrypt(key, data.slice(0, 16), data.slice(16));
        }
      };
    }
  };
}

/* ------------------------------------------------------------------ *
 * Walking a pdf-lib document and transforming every string / stream
 * ------------------------------------------------------------------ */

function isStringObj(o) {
  return o instanceof PDFString || o instanceof PDFHexString;
}

// asBytes() decodes both forms properly: hex digits for <...>, and the escape
// sequences (\(, \), \\, \n, octal) that a parsed literal string still carries.
function stringBytes(o) {
  if (typeof o.asBytes === 'function') return o.asBytes();
  if (o instanceof PDFHexString) return hexToBytes(o.value);
  return latin1Bytes(o.value !== undefined ? o.value : String(o));
}

async function transformObject(obj, xform, seen) {
  if (obj instanceof PDFArray) {
    if (seen.has(obj)) return obj;
    seen.add(obj);
    for (let i = 0; i < obj.size(); i++) {
      const child = obj.get(i);
      const next = await transformObject(child, xform, seen);
      if (next !== child) obj.set(i, next);
    }
    return obj;
  }
  if (obj instanceof PDFRawStream) {
    if (seen.has(obj)) return obj;
    seen.add(obj);
    await transformObject(obj.dict, xform, seen);
    obj.contents = await xform(obj.contents);
    obj.dict.set(PDFName.of('Length'), PDFNumber.of(obj.contents.length));
    return obj;
  }
  if (obj instanceof PDFDict) {
    if (seen.has(obj)) return obj;
    seen.add(obj);
    for (const [key, child] of obj.entries()) {
      const next = await transformObject(child, xform, seen);
      if (next !== child) obj.set(key, next);
    }
    return obj;
  }
  if (isStringObj(obj)) {
    const out = await xform(stringBytes(obj));
    return PDFHexString.of(bytesToHex(out));
  }
  return obj;
}

async function walkAndTransform(context, pick, skipTags) {
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (skipTags && skipTags.has(ref.tag)) continue;
    await transformObject(obj, pick(ref.objectNumber, ref.generationNumber), new Set());
  }
}

/* ------------------------------------------------------------------ *
 * Public API — encrypt
 * ------------------------------------------------------------------ */

const SCHEMES = {
  rc4:    { V: 2, R: 3, lengthBits: 128, keyLen: 16 },
  aes128: { V: 4, R: 4, lengthBits: 128, keyLen: 16 },
  aes256: { V: 5, R: 6, lengthBits: 256, keyLen: 32 }
};

/**
 * Password-protect a PDF.
 *
 * @param {Uint8Array} bytes                 document to protect
 * @param {object}     opts
 * @param {string}     opts.userPassword     password required to open
 * @param {string}     opts.ownerPassword    password granting full rights
 * @param {string}     opts.scheme           'aes256' | 'aes128' | 'rc4'
 * @param {object}     opts.permissions      keys of PERM_BITS mapped to booleans
 * @returns {Promise<Uint8Array>}
 */
async function addPassword(bytes, opts) {
  const scheme = SCHEMES[opts.scheme] ? opts.scheme : 'aes128';
  const spec = SCHEMES[scheme];
  const userPw = String(opts.userPassword || '');
  const ownerPw = String(opts.ownerPassword || '') || userPw;
  if (!userPw && !ownerPw) throw new Error('Set at least one password.');

  // Re-serialise without object streams first: every object has to be reachable
  // as a plain indirect object so its strings and streams can be encrypted.
  //
  // `updateMetadata: false` matters here: pdf-lib otherwise rewrites /Producer
  // and /ModDate during save(), which would land in the file as clear text
  // after the encryption walk has already run.
  const loadOpts = { ignoreEncryption: true, updateMetadata: false };
  const first = await PDFDocument.load(bytes, loadOpts);
  const flat = await first.save({ useObjectStreams: false });
  const doc = await PDFDocument.load(flat, loadOpts);
  const context = doc.context;

  const idBytes = randomBytes(16);
  const idArr = PDFArray.withContext(context);
  idArr.push(PDFHexString.of(bytesToHex(idBytes)));
  idArr.push(PDFHexString.of(bytesToHex(idBytes)));
  context.trailerInfo.ID = idArr;

  const P = permissionsToP(opts.permissions);
  const encDict = context.obj({});
  encDict.set(PDFName.of('Filter'), PDFName.of('Standard'));
  encDict.set(PDFName.of('V'), PDFNumber.of(spec.V));
  encDict.set(PDFName.of('R'), PDFNumber.of(spec.R));
  encDict.set(PDFName.of('Length'), PDFNumber.of(spec.lengthBits));
  encDict.set(PDFName.of('P'), PDFNumber.of(P));
  encDict.set(PDFName.of('EncryptMetadata'), PDFBool.True);

  let fileKey;
  if (scheme === 'aes256') {
    fileKey = randomBytes(32);
    const upw = utf8Bytes(userPw).slice(0, 127);
    const opw = utf8Bytes(ownerPw).slice(0, 127);
    const empty = new Uint8Array(0);
    const zeroIv = new Uint8Array(16);

    const uValidSalt = randomBytes(8);
    const uKeySalt = randomBytes(8);
    const U = concat([await hash2B(upw, uValidSalt, empty, 6), uValidSalt, uKeySalt]);
    const uInter = await hash2B(upw, uKeySalt, empty, 6);
    const UE = await aesCbcEncryptNoPad(uInter, zeroIv, fileKey);

    const oValidSalt = randomBytes(8);
    const oKeySalt = randomBytes(8);
    const O = concat([await hash2B(opw, oValidSalt, U, 6), oValidSalt, oKeySalt]);
    const oInter = await hash2B(opw, oKeySalt, U, 6);
    const OE = await aesCbcEncryptNoPad(oInter, zeroIv, fileKey);

    const permsPlain = concat([
      int32le(P),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x54 /* T */, 0x61, 0x64, 0x62]),
      randomBytes(4)
    ]);
    const Perms = await aesCbcEncryptNoPad(fileKey, zeroIv, permsPlain);

    encDict.set(PDFName.of('U'), PDFHexString.of(bytesToHex(U)));
    encDict.set(PDFName.of('UE'), PDFHexString.of(bytesToHex(UE)));
    encDict.set(PDFName.of('O'), PDFHexString.of(bytesToHex(O)));
    encDict.set(PDFName.of('OE'), PDFHexString.of(bytesToHex(OE)));
    encDict.set(PDFName.of('Perms'), PDFHexString.of(bytesToHex(Perms)));
  } else {
    const O = computeO(latin1Bytes(ownerPw), latin1Bytes(userPw), spec.keyLen, spec.R);
    fileKey = computeKeyR234(latin1Bytes(userPw), O, P, idBytes, spec.keyLen, spec.R, true);
    const U = computeU(fileKey, idBytes, spec.R);
    encDict.set(PDFName.of('O'), PDFHexString.of(bytesToHex(O)));
    encDict.set(PDFName.of('U'), PDFHexString.of(bytesToHex(U)));
  }

  if (scheme !== 'rc4') {
    const cf = context.obj({});
    const stdCf = context.obj({});
    stdCf.set(PDFName.of('CFM'), PDFName.of(scheme === 'aes256' ? 'AESV3' : 'AESV2'));
    stdCf.set(PDFName.of('AuthEvent'), PDFName.of('DocOpen'));
    stdCf.set(PDFName.of('Length'), PDFNumber.of(spec.keyLen));
    cf.set(PDFName.of('StdCF'), stdCf);
    encDict.set(PDFName.of('CF'), cf);
    encDict.set(PDFName.of('StmF'), PDFName.of('StdCF'));
    encDict.set(PDFName.of('StrF'), PDFName.of('StdCF'));
  }

  const cipher = makeCipher(scheme, fileKey);
  await walkAndTransform(context, (num, gen) => cipher.forObject(num, gen).encrypt, null);

  // Registered after the walk so /O, /U and /Perms stay in the clear.
  context.trailerInfo.Encrypt = context.register(encDict);

  return doc.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------------ *
 * Public API — decrypt
 * ------------------------------------------------------------------ */

function dictString(dict, key) {
  const v = dict.get(PDFName.of(key));
  return v && isStringObj(v) ? stringBytes(v) : null;
}

function dictNumber(dict, key, fallback) {
  const v = dict.get(PDFName.of(key));
  return v && typeof v.asNumber === 'function' ? v.asNumber() : fallback;
}

function dictBool(dict, key, fallback) {
  const v = dict.get(PDFName.of(key));
  if (!v) return fallback;
  if (typeof v.asBoolean === 'function') return v.asBoolean();
  return fallback;
}

function schemeFromEncrypt(encDict) {
  const V = dictNumber(encDict, 'V', 0);
  if (V === 5) return 'aes256';
  if (V === 4) {
    const cf = encDict.get(PDFName.of('CF'));
    const std = cf && cf.get ? cf.get(PDFName.of('StdCF')) : null;
    const cfm = std && std.get ? std.get(PDFName.of('CFM')) : null;
    const name = cfm && cfm.asString ? cfm.asString() : '';
    return name === '/V2' || name === '/RC4' ? 'rc4' : 'aes128';
  }
  return 'rc4';
}

async function deriveFileKey(encDict, idFirst, password) {
  const scheme = schemeFromEncrypt(encDict);
  const R = dictNumber(encDict, 'R', 3);
  const O = dictString(encDict, 'O') || new Uint8Array(48);
  const U = dictString(encDict, 'U') || new Uint8Array(48);
  const P = dictNumber(encDict, 'P', -1) | 0;
  const encryptMetadata = dictBool(encDict, 'EncryptMetadata', true);

  if (scheme === 'aes256') {
    const pw = utf8Bytes(password).slice(0, 127);
    const zeroIv = new Uint8Array(16);

    const uCheck = await hash2B(pw, U.slice(32, 40), new Uint8Array(0), R);
    if (sameBytes(uCheck, U, 32)) {
      const inter = await hash2B(pw, U.slice(40, 48), new Uint8Array(0), R);
      const UE = dictString(encDict, 'UE');
      if (!UE) throw new Error('The encryption dictionary is missing /UE.');
      return { scheme, key: await aesCbcDecryptNoPad(inter, zeroIv, UE) };
    }

    const u48 = U.slice(0, 48);
    const oCheck = await hash2B(pw, O.slice(32, 40), u48, R);
    if (!sameBytes(oCheck, O, 32)) throw new Error('WRONG_PASSWORD');
    const inter = await hash2B(pw, O.slice(40, 48), u48, R);
    const OE = dictString(encDict, 'OE');
    if (!OE) throw new Error('The encryption dictionary is missing /OE.');
    return { scheme, key: await aesCbcDecryptNoPad(inter, zeroIv, OE) };
  }

  const lengthBits = dictNumber(encDict, 'Length', 40);
  const keyLen = R === 2 ? 5 : Math.max(5, Math.min(16, Math.floor(lengthBits / 8)));
  const compareLen = R === 2 ? 32 : 16;

  // A user password authenticates when the recomputed /U matches the stored one.
  let key = computeKeyR234(latin1Bytes(password), O, P, idFirst, keyLen, R, encryptMetadata);
  if (sameBytes(computeU(key, idFirst, R), U, compareLen)) return { scheme, key };

  // Otherwise treat it as the owner password and recover the user password.
  let hash = md5(padPassword(latin1Bytes(password)));
  if (R >= 3) for (let i = 0; i < 50; i++) hash = md5(hash);
  const rc4Key = hash.slice(0, keyLen);
  let userPad = O.slice(0, 32);
  if (R === 2) {
    userPad = rc4(rc4Key, userPad);
  } else {
    const tmp = new Uint8Array(rc4Key.length);
    for (let i = 19; i >= 0; i--) {
      for (let k = 0; k < rc4Key.length; k++) tmp[k] = rc4Key[k] ^ i;
      userPad = rc4(tmp, userPad);
    }
  }
  key = computeKeyR234(userPad, O, P, idFirst, keyLen, R, encryptMetadata);
  if (!sameBytes(computeU(key, idFirst, R), U, compareLen)) throw new Error('WRONG_PASSWORD');
  return { scheme, key };
}

// Carries the underlying parser or cipher failure so it can be reported,
// while keeping the sentinel message the caller matches on.
function unsupported(cause) {
  const err = new Error('UNSUPPORTED_STRUCTURE');
  err.cause = cause;
  return err;
}

/**
 * Strip password protection, producing the same document without encryption.
 * Throws 'WRONG_PASSWORD' when the password does not authenticate, and
 * 'UNSUPPORTED_STRUCTURE' when the object layout cannot be rewritten
 * losslessly — the caller can then fall back to rebuilding the pages.
 */
async function removePassword(bytes, password) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false
    });
  } catch (err) {
    throw unsupported(err);
  }
  const context = doc.context;
  const encEntry = context.trailerInfo.Encrypt;
  if (!encEntry) return bytes; // not encrypted at all

  const encDict = encEntry instanceof PDFRef ? context.lookup(encEntry) : encEntry;
  if (!encDict || !encDict.get) throw new Error('UNSUPPORTED_STRUCTURE');

  const filter = encDict.get(PDFName.of('Filter'));
  if (filter && filter.asString && filter.asString() !== '/Standard') {
    throw new Error('This file uses a custom security handler that cannot be removed here.');
  }

  let idFirst = new Uint8Array(0);
  const id = context.trailerInfo.ID;
  if (id && typeof id.get === 'function') {
    const firstId = id.get(0);
    if (firstId && isStringObj(firstId)) idFirst = stringBytes(firstId);
  }

  const { scheme, key } = await deriveFileKey(encDict, idFirst, String(password || ''));
  const cipher = makeCipher(scheme, key);

  const skip = new Set();
  if (encEntry instanceof PDFRef) skip.add(encEntry.tag);

  try {
    await walkAndTransform(context, (num, gen) => cipher.forObject(num, gen).decrypt, skip);
  } catch (err) {
    throw unsupported(err);
  }

  context.trailerInfo.Encrypt = undefined;
  if (encEntry instanceof PDFRef) context.delete(encEntry);
  return doc.save({ useObjectStreams: false });
}

/**
 * Report the encryption state of a document without needing the password.
 */
async function inspect(bytes) {
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false
    });
    const enc = doc.context.trailerInfo.Encrypt;
    if (!enc) return { encrypted: false };
    const dict = enc instanceof PDFRef ? doc.context.lookup(enc) : enc;
    if (!dict || !dict.get) return { encrypted: true };
    return {
      encrypted: true,
      scheme: schemeFromEncrypt(dict),
      permissions: pToPermissions(dictNumber(dict, 'P', -1) | 0)
    };
  } catch (err) {
    return { encrypted: false, error: (err && err.message) || String(err) };
  }
}

root.PSCrypt = {
  addPassword,
  removePassword,
  inspect,
  permissionsToP,
  pToPermissions,
  PERM_BITS,
  _internals: { md5, rc4, hash2B, computeO, computeU, computeKeyR234, bytesToHex, hexToBytes }
};

})(typeof window !== 'undefined' ? window : globalThis);
