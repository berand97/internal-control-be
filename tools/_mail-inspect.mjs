import pg from 'pg';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY = 'GWKdFu/Yf1wPcEXk7xOa3L2IJIDRu3/4T6i2l8OXwjI=';
const PREFIX = 'enc.v1.';
const deriveKey = (secret) => createHash('sha256').update(secret).digest();
const seal = (plain) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(KEY), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX + iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
};
const open = (value) => {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return value;
  const [ivPart, tagPart, dataPart] = value.slice(PREFIX.length).split('.');
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const data = Buffer.from(dataPart, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(KEY), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()].toString('utf8'));
};

const client = new pg.Client('postgresql://postgres:postgres@localhost:5432/internal_control');
await client.connect();
const { rows } = await client.query('SELECT * FROM mail_settings LIMIT 1');
console.log(JSON.stringify(rows.map(r => ({
  id: r.id,
  port: r.port,
  secure: r.secure,
  enabled: r.enabled,
  host: r.host?.slice(0, 40),
  username: r.username?.slice(0, 40),
  password: r.password?.slice(0, 40),
  from_name: r.from_name?.slice(0, 40),
  from_email: r.from_email?.slice(0, 40),
  host_sealed: r.host?.startsWith(PREFIX),
})), null, 2));
for (const field of ['host','username','password','from_name','from_email']) {
  const v = rows[0]?.[field];
  try {
    const plain = open(v);
    console.log(field, 'OK', plain);
  } catch (e) {
    console.log(field, 'FAIL', e.message);
  }
}
await client.end();
