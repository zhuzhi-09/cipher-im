/**
 * 用现有 TS 实现回放 spec/vectors/crypto-v1.json，逐项比对
 * 目的：确认测试数据本身自洽、可回放。Dart 端的校验器照着这个文件的逻辑写。
 * 用法：bash scripts/vectors.sh verify
 */
import fs from 'node:fs';
import path from 'node:path';
import { installDeterministicRng, setRng } from './rng';
import {
  sha256,
  hkdf,
  hmacSha256,
  dhPubFromPriv,
  dh,
  sigPub,
  sign,
  verify as edVerify,
  aeadSeal,
  aeadOpen,
  aeadSealRandom,
  aeadOpenRandom,
  pbkdf2,
  toHex,
  fromHex,
  toB64,
  fromB64,
  utf8,
  fromUtf8,
  concat,
} from '../../shared/crypto/primitives';
import { createDeviceKeys, createIdentity, PublicBundle } from '../../shared/crypto/identity';
import { x3dhInitiate } from '../../shared/crypto/x3dh';
import { safetyNumber, shortFingerprint } from '../../shared/crypto/fingerprint';
import { createRoamKeys, sealForRoam, openRoam, wrapRoamPriv, unwrapRoamPriv } from '../../shared/crypto/roam';
import { deserializeKeys, serializeKeys, Step, World } from './ops';

installDeterministicRng();

let pass = 0;
const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fails.push(name);
    console.log(`  ✗ ${name}\n      得到 ${g.slice(0, 300)}\n      期望 ${w.slice(0, 300)}`);
  }
};

async function main() {
  const v = JSON.parse(fs.readFileSync(path.resolve('spec/vectors/crypto-v1.json'), 'utf8'));
  const P = v.primitives;

  console.log('[primitives]');
  for (const [i, c] of P.sha256.entries()) eq(`sha256#${i}`, toHex(sha256(fromHex(c.in))), c.out);
  for (const [i, c] of P.hkdf.entries()) eq(`hkdf#${i}`, toHex(hkdf(fromHex(c.ikm), fromHex(c.salt), c.info, c.len)), c.out);
  for (const [i, c] of P.hmac.entries()) eq(`hmac#${i}`, toHex(hmacSha256(fromHex(c.key), fromHex(c.data))), c.out);
  for (const [i, c] of P.x25519.entries()) {
    eq(`x25519.pub#${i}`, toHex(dhPubFromPriv(fromHex(c.priv))), c.pub);
    eq(`x25519.shared#${i}`, toHex(dh(fromHex(c.priv), fromHex(c.peerPub))), c.shared);
  }
  for (const [i, c] of P.ed25519.entries()) {
    eq(`ed25519.pub#${i}`, toHex(sigPub(fromHex(c.seed))), c.pub);
    eq(`ed25519.sig#${i}`, toHex(sign(fromHex(c.seed), fromHex(c.msg))), c.sig);
    eq(`ed25519.verify#${i}`, edVerify(fromHex(c.pub), fromHex(c.msg), fromHex(c.sig)), true);
  }
  for (const [i, c] of P.aead.entries()) {
    const key = fromHex(c.key);
    eq(`aead.nonce#${i}`, toHex(sha256(concat(key, utf8('aead-nonce'))).slice(0, 12)), c.nonce);
    eq(`aead.seal#${i}`, toHex(await aeadSeal(key, fromHex(c.pt), fromHex(c.aad))), c.ct);
    eq(`aead.open#${i}`, toHex(await aeadOpen(key, fromHex(c.ct), fromHex(c.aad))), c.pt);
  }
  for (const [i, c] of P.aeadRandom.entries()) {
    setRng(c.rng);
    eq(`aeadRandom.seal#${i}`, toHex(await aeadSealRandom(fromHex(c.key), fromHex(c.pt), fromHex(c.aad))), c.packed);
    eq(`aeadRandom.open#${i}`, toHex(await aeadOpenRandom(fromHex(c.key), fromHex(c.packed), fromHex(c.aad))), c.pt);
  }
  for (const [i, c] of P.pbkdf2.entries()) eq(`pbkdf2#${i}`, toHex(await pbkdf2(c.password, fromHex(c.salt), c.iterations)), c.out);
  for (const [i, c] of P.base64.entries()) {
    eq(`b64.enc#${i}`, toB64(fromHex(c.hex)), c.b64);
    eq(`b64.dec#${i}`, toHex(fromB64(c.b64)), c.hex);
  }

  console.log('[identity]');
  for (const c of v.identity) {
    setRng(c.rng);
    if (c.identityOnly) {
      const id = createIdentity();
      eq(`identity ${c.rng}`, { sigSeed: toB64(id.sigSeed), dhPriv: toB64(id.dhPriv), ikSigPub: toB64(id.ikSigPub), ikDhPub: toB64(id.ikDhPub) }, c.identityOnly);
    } else {
      eq(`deviceKeys ${c.rng}`, serializeKeys(createDeviceKeys(c.opkCount)), c.keys);
    }
  }
  for (const [name, p] of Object.entries<any>(v.parties)) {
    setRng(`keys-${name}`);
    eq(`party keys ${name}`, serializeKeys(createDeviceKeys(p.keys.opks.length)), p.keys);
  }

  console.log('[fingerprint]');
  for (const [i, c] of v.fingerprint.safety.entries()) {
    eq(`safety#${i}`, safetyNumber(fromB64(c.a), fromB64(c.b)), c.digits);
    eq(`safety#${i} 对称`, safetyNumber(fromB64(c.b), fromB64(c.a)), c.digits);
  }
  for (const [i, c] of v.fingerprint.short.entries()) eq(`short#${i}`, shortFingerprint(fromB64(c.ikSigPub)), c.out);

  console.log('[x3dh]');
  for (const c of v.x3dh) {
    const alice = deserializeKeys(v.parties[c.initiator].keys);
    setRng(c.rng);
    let out: unknown;
    try {
      const r = x3dhInitiate(alice.identity, c.bundle as PublicBundle);
      out = { sk: toB64(r.sk), ad: toB64(r.ad), ekPriv: toB64(r.ekPriv), ekPub: toB64(r.ekPub), spkId: r.spkId, opkId: r.opkId };
    } catch {
      out = { error: true };
    }
    eq(`x3dh ${c.name}`, out, c.out);
  }

  console.log('[transcript]');
  const world = new World(v.parties);
  for (const [i, s] of (v.transcript as Step[]).entries()) {
    eq(`step ${i} ${s.op} ${s.note}`, await world.run(s), s.expect);
  }

  console.log('[roam]');
  const R = v.roam;
  setRng(R.rng);
  const kp = createRoamKeys();
  eq('roam keys', { priv: toB64(kp.priv), pub: toB64(kp.pub) }, { priv: R.priv, pub: R.pub });
  for (const [i, s] of R.seals.entries()) {
    setRng(s.rng);
    eq(`roam.seal#${i}`, await sealForRoam(fromB64(R.pub), utf8(s.plaintext)), { eph: s.eph, ct: s.ct });
    eq(`roam.open#${i}`, fromUtf8(await openRoam(fromB64(R.priv), s.eph, s.ct)), s.plaintext);
  }
  setRng(R.wrap.rng);
  eq('roam.wrap', await wrapRoamPriv(R.wrap.password, fromB64(R.priv)), { salt: R.wrap.salt, sealed: R.wrap.sealed });
  eq('roam.unwrap', toB64(await unwrapRoamPriv(R.wrap.password, R.wrap.salt, R.wrap.sealed)), R.priv);
  let wrong = false;
  try {
    await unwrapRoamPriv('错的口令', R.wrap.salt, R.wrap.sealed);
  } catch {
    wrong = true;
  }
  eq('roam.unwrap 错口令必须失败', wrong, true);

  console.log('[blob]');
  for (const [i, b] of v.blob.entries()) {
    eq(`blob.seal#${i}`, toB64(await aeadSeal(fromB64(b.key), fromB64(b.data), utf8('blob'))), b.ct);
    eq(`blob.open#${i}`, toB64(await aeadOpen(fromB64(b.key), fromB64(b.ct), utf8('blob'))), b.data);
  }

  console.log(`\n测试数据回放 ${pass}/${pass + fails.length}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
