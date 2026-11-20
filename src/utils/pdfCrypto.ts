import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';

// ISO 32000-1 Standard Security Handler Padding String (32 bytes)
const PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

// Pure TypeScript MD5 over Uint8Array (zero external dependencies)
function md5(input: Uint8Array): Uint8Array {
  const origLen = input.length;
  const bitLen = origLen * 8;
  const padLen = ((56 - ((origLen + 1) % 64)) + 64) % 64;
  const totalLen = origLen + 1 + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(input);
  buf[origLen] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, bitLen >>> 0, true);
  view.setUint32(totalLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  for (let offset = 0; offset < totalLen; offset += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      const rot = s[i];
      B = (B + (((F << rot) | (F >>> (32 - rot))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

function padPassword(password: string): Uint8Array {
  const raw = new TextEncoder().encode(password);
  const padded = new Uint8Array(32);
  const copyLen = Math.min(32, raw.length);
  padded.set(raw.subarray(0, copyLen), 0);
  if (copyLen < 32) {
    padded.set(PADDING.subarray(0, 32 - copyLen), copyLen);
  }
  return padded;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    res.set(a, offset);
    offset += a.length;
  }
  return res;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function decodePdfStringBytes(strObj: PDFString | PDFHexString): Uint8Array {
  if (strObj instanceof PDFHexString) {
    const hex = strObj.asString().replace(/\s+/g, '');
    const padded = hex.length % 2 === 1 ? hex + '0' : hex;
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return out;
  }
  const raw = strObj.asBytes();
  return new Uint8Array(raw);
}

export interface PdfPermissionOptions {
  userPassword: string;
  ownerPassword?: string;
  allowPrint?: boolean;
  allowCopy?: boolean;
  allowModify?: boolean;
  allowAnnotations?: boolean;
}

/**
 * Encrypts a PDFDocument in-place using ISO 32000-1 Standard Security Handler (RC4-128, V=2, R=3)
 * and returns the encrypted PDF bytes.
 */
export async function encryptPdfDocument(
  pdfDoc: PDFDocument,
  options: PdfPermissionOptions
): Promise<Uint8Array> {
  // Normalize all PDFContentStream / PDFFlateStream objects into finalized PDFRawStream objects
  const plainBytes = await pdfDoc.save({ useObjectStreams: false });
  const targetDoc = await PDFDocument.load(plainBytes, { ignoreEncryption: true });

  const userPwd = options.userPassword || '';
  const ownerPwd = options.ownerPassword || userPwd || 'folioforge_owner';

  // Build 32-bit P permission flags per ISO 32000-1 Table 22
  // Bits 1-2 must be 0, bits 7-8 = 1, bits 13-32 = 1 -> base -3904 (0xFFFFF0C0)
  let pFlags = -3904;
  if (options.allowPrint !== false) pFlags |= 1 << 2; // bit 3
  if (options.allowModify) pFlags |= 1 << 3; // bit 4
  if (options.allowCopy) pFlags |= 1 << 4; // bit 5
  if (options.allowAnnotations) pFlags |= 1 << 5; // bit 6
  if (options.allowPrint !== false) pFlags |= 1 << 11; // bit 12 high-res print

  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, pFlags, true);

  // Generate 16-byte Document File ID
  const fileId = crypto.getRandomValues(new Uint8Array(16));

  // Algorithm 3: Compute O value (32 bytes)
  let ownerDigest = md5(padPassword(ownerPwd));
  for (let i = 0; i < 50; i++) {
    ownerDigest = md5(ownerDigest);
  }
  const ownerKey = ownerDigest.subarray(0, 16);
  let oVal = rc4(ownerKey, padPassword(userPwd));
  for (let i = 1; i <= 19; i++) {
    const tmpKey = new Uint8Array(16);
    for (let k = 0; k < 16; k++) tmpKey[k] = ownerKey[k] ^ i;
    oVal = rc4(tmpKey, oVal);
  }

  // Algorithm 2: Compute File Encryption Key (16 bytes)
  let encDigest = md5(concatBytes(padPassword(userPwd), oVal, pBytes, fileId));
  for (let i = 0; i < 50; i++) {
    encDigest = md5(encDigest);
  }
  const fileKey = encDigest.subarray(0, 16);

  // Algorithm 5: Compute U value (32 bytes)
  const uDigest = md5(concatBytes(PADDING, fileId));
  let uVal = rc4(fileKey, uDigest);
  for (let i = 1; i <= 19; i++) {
    const tmpKey = new Uint8Array(16);
    for (let k = 0; k < 16; k++) tmpKey[k] = fileKey[k] ^ i;
    uVal = rc4(tmpKey, uVal);
  }
  const uFull = concatBytes(uVal, crypto.getRandomValues(new Uint8Array(16)));

  const context = targetDoc.context;

  // Encrypt all existing indirect objects before attaching /Encrypt dict
  const indirectObjects = context.enumerateIndirectObjects();

  const encryptStringDeep = (obj: unknown, objKey: Uint8Array, parentDict?: PDFDict, keyName?: PDFName): void => {
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      const plain = decodePdfStringBytes(obj);
      const cipher = rc4(objKey, plain);
      const hexObj = PDFHexString.of(toHex(cipher));
      if (parentDict && keyName) {
        parentDict.set(keyName, hexObj);
      }
    } else if (obj instanceof PDFDict) {
      const entries = obj.entries();
      for (const [k, v] of entries) {
        if (v instanceof PDFString || v instanceof PDFHexString) {
          encryptStringDeep(v, objKey, obj, k);
        } else {
          encryptStringDeep(v, objKey);
        }
      }
    } else if (obj instanceof PDFArray) {
      for (let idx = 0; idx < obj.size(); idx++) {
        const item = obj.get(idx);
        if (item instanceof PDFString || item instanceof PDFHexString) {
          const plain = decodePdfStringBytes(item);
          const cipher = rc4(objKey, plain);
          obj.set(idx, PDFHexString.of(toHex(cipher)));
        } else {
          encryptStringDeep(item, objKey);
        }
      }
    }
  };

  for (const [ref, pdfObj] of indirectObjects) {
    if (!(ref instanceof PDFRef)) continue;
    const objKeyInput = new Uint8Array(16 + 5);
    objKeyInput.set(fileKey, 0);
    objKeyInput[16] = ref.objectNumber & 0xff;
    objKeyInput[17] = (ref.objectNumber >> 8) & 0xff;
    objKeyInput[18] = (ref.objectNumber >> 16) & 0xff;
    objKeyInput[19] = ref.generationNumber & 0xff;
    objKeyInput[20] = (ref.generationNumber >> 8) & 0xff;
    const objKey = md5(objKeyInput); // 16 bytes for 128-bit key

    if (pdfObj instanceof PDFRawStream) {
      // Encrypt stream dict strings AND stream contents
      encryptStringDeep(pdfObj.dict, objKey);
      const encryptedStream = rc4(objKey, pdfObj.contents);
      const mutableStream = pdfObj as unknown as { contents: Uint8Array };
      mutableStream.contents = encryptedStream;
    } else {
      encryptStringDeep(pdfObj, objKey);
    }
  }

  // Create /Encrypt dictionary
  const encryptDict = context.obj({
    Filter: PDFName.of('Standard'),
    V: PDFNumber.of(2),
    R: PDFNumber.of(3),
    Length: PDFNumber.of(128),
    P: PDFNumber.of(pFlags),
    O: PDFHexString.of(toHex(oVal)),
    U: PDFHexString.of(toHex(uFull)),
  });
  const encryptRef = context.register(encryptDict);

  // Attach /Encrypt and /ID to Trailer Info
  const idHex = PDFHexString.of(toHex(fileId));
  const idArray = context.obj([idHex, idHex]);
  context.trailerInfo.Encrypt = encryptRef;
  context.trailerInfo.ID = idArray;

  return targetDoc.save({ useObjectStreams: false });
}
