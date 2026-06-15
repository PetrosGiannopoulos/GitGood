// OpenSSH key-encoding helpers (pure functions extracted from main.js).
const { createHash } = require('crypto');

// OpenSSH wire-format helper: each component is preceded by a 4-byte BE length
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

// OpenSSH mpint: leading zero stripped, but a leading zero byte added back if the
// high bit is set (so it doesn't get interpreted as a negative number).
function sshMpint(buf) {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  buf = buf.slice(start);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return sshString(buf);
}

// Decode base64url (JWK uses this; replace -→+, _→/, repad)
function fromB64Url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='), 'base64');
}

function ed25519PublicSsh(jwk, comment) {
  const type = Buffer.from('ssh-ed25519');
  const x = fromB64Url(jwk.x);
  const body = Buffer.concat([sshString(type), sshString(x)]);
  return 'ssh-ed25519 ' + body.toString('base64') + (comment ? ' ' + comment : '');
}

function rsaPublicSsh(jwk, comment) {
  const type = Buffer.from('ssh-rsa');
  const e = fromB64Url(jwk.e);
  const n = fromB64Url(jwk.n);
  const body = Buffer.concat([sshString(type), sshMpint(e), sshMpint(n)]);
  return 'ssh-rsa ' + body.toString('base64') + (comment ? ' ' + comment : '');
}

function ecdsaPublicSsh(jwk, comment) {
  const curveMap = {
    'P-256': { id: 'nistp256', sshName: 'ecdsa-sha2-nistp256', size: 32 },
    'P-384': { id: 'nistp384', sshName: 'ecdsa-sha2-nistp384', size: 48 },
    'P-521': { id: 'nistp521', sshName: 'ecdsa-sha2-nistp521', size: 66 }
  };
  const c = curveMap[jwk.crv];
  if (!c) throw new Error('Unsupported ECDSA curve: ' + jwk.crv);
  const type = Buffer.from(c.sshName);
  const idBuf = Buffer.from(c.id);
  const x = fromB64Url(jwk.x);
  const y = fromB64Url(jwk.y);
  const padX = Buffer.concat([Buffer.alloc(Math.max(0, c.size - x.length)), x]);
  const padY = Buffer.concat([Buffer.alloc(Math.max(0, c.size - y.length)), y]);
  const point = Buffer.concat([Buffer.from([0x04]), padX, padY]);
  const body = Buffer.concat([sshString(type), sshString(idBuf), sshString(point)]);
  return c.sshName + ' ' + body.toString('base64') + (comment ? ' ' + comment : '');
}

// Compute an SSH-style fingerprint (SHA256:<base64>) of a public key line.
function fingerprintFromPublicLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return '';
  try {
    const keyData = Buffer.from(parts[1], 'base64');
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(keyData).digest('base64').replace(/=+$/, '');
    return 'SHA256:' + hash;
  } catch (e) {
    return '';
  }
}

// Suggested default filename for a key (based on type/bits)
function defaultKeyName(type, bits, curve) {
  if (type === 'ed25519') return 'id_ed25519';
  if (type === 'rsa') return 'id_rsa';
  if (type === 'ecdsa') return 'id_ecdsa';
  return 'id_key';
}

module.exports = { sshString, sshMpint, fromB64Url, ed25519PublicSsh, rsaPublicSsh, ecdsaPublicSsh, fingerprintFromPublicLine, defaultKeyName };
