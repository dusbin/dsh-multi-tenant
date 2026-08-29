/**
 * 最小 LDAPv3 模拟服务器（仅用于开发/测试/冒烟，非生产组件）。
 *
 * 实现足够 ldapts 跑通 bind + search 的最小协议子集（BER 编码）：
 *  - BindRequest(0x60) → BindResponse(0x61)（成功 0 / 凭据错误 49）
 *  - SearchRequest(0x63) → SearchResultEntry(0x64) + SearchResultDone(0x65)
 *  - UnbindRequest(0x42) → 关闭连接
 *
 * 用法：startLdapMock({ users, bindDn, bindPassword }) → { port, close }
 *  users: [{ dn, password, attributes: { uid: 'jdoe', mail: ..., cn: ... } }]
 */

import net from 'node:net';

// ---- BER 编码 ----
function encLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  const out = Buffer.alloc(3);
  out[0] = 0x82;
  out.writeUInt16BE(len, 1);
  return out;
}
function tlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encLength(value.length), value]);
}
function seq(...parts) {
  return tlv(0x30, Buffer.concat(parts));
}
function integer(n) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n, 0);
  // 紧凑化
  let start = 0;
  while (start < 3 && ((buf[start] === 0 && !(buf[start + 1] & 0x80)) || (buf[start] === 0xff && (buf[start + 1] & 0x80)))) start += 1;
  return tlv(0x02, buf.subarray(start));
}
function octet(s) {
  return tlv(0x04, Buffer.from(String(s), 'utf8'));
}
function enumerated(n) {
  return tlv(0x0a, Buffer.from([n]));
}
function boolean(v) {
  return tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
}
function filterEquality(attr, value) {
  return tlv(0xa3, seq(octet(attr), octet(value)));
}

// ---- BER 解析 ----
function readTlv(buf, offset) {
  if (offset + 2 > buf.length) return null;
  const tag = buf[offset];
  let len = buf[offset + 1];
  let lenBytes = 0;
  if (len & 0x80) {
    lenBytes = len & 0x7f;
    if (lenBytes === 0 || lenBytes > 4 || offset + 2 + lenBytes > buf.length) return null;
    len = 0;
    for (let i = 0; i < lenBytes; i += 1) len = len * 256 + buf[offset + 2 + i];
  }
  if (offset + 2 + lenBytes + len > buf.length) return null;
  return { tag, value: buf.subarray(offset + 2 + lenBytes, offset + 2 + lenBytes + len), next: offset + 2 + lenBytes + len };
}

function parseSequence(v) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const t = readTlv(v, offset);
    if (!t) break;
    parts.push(t);
    offset = t.next;
  }
  return parts;
}
function asInteger(t) { return t.value.length ? t.value.readIntBE(0, t.value.length) : 0; }
function asString(t) { return t.value.toString('utf8'); }

// 注意：application 标签（0x61/0x64/0x65）本身即 SEQUENCE，其值直接是字段，
// 不能再嵌套一层 0x30。
function bindResponse(messageId, resultCode) {
  return seq(integer(messageId), tlv(0x61, Buffer.concat([enumerated(resultCode), octet(''), octet('')])));
}
function searchResultEntry(messageId, entry) {
  const attrs = Object.entries(entry.attributes).map(([type, vals]) => {
    // PartialAttribute: SEQUENCE { type, vals SET OF } —— vals 是 SET(0x31)
    const list = (Array.isArray(vals) ? vals : [vals]).map((v) => octet(v));
    return seq(octet(type), tlv(0x31, Buffer.concat(list)));
  });
  return seq(integer(messageId), tlv(0x64, Buffer.concat([octet(entry.dn), tlv(0x30, Buffer.concat(attrs))])));
}
function searchResultDone(messageId, resultCode) {
  return seq(integer(messageId), tlv(0x65, Buffer.concat([enumerated(resultCode), octet(''), octet('')])));
}

/**
 * @param {object} opts
 * @param {Array<{dn: string, password: string, attributes: object}>} opts.users
 * @param {string} [opts.bindDn]  服务账号 DN（要求 bind 匹配）
 * @param {string} [opts.bindPassword]
 */
export function startLdapMock({ users = [], bindDn = null, bindPassword = null }) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (process.env.LDAP_MOCK_DEBUG) console.log('[mock] recv bytes:', buffer.length, buffer.subarray(0, 40).toString('hex'));
      for (;;) {
        // 完整 LDAPMessage：SEQUENCE { messageID, op }
        const msg = readTlv(buffer, 0);
        if (!msg || msg.tag !== 0x30) break;
        buffer = buffer.subarray(msg.next);
        const [messageIdTlv, opTlv] = parseSequence(msg.value);
        if (process.env.LDAP_MOCK_DEBUG) console.log('[mock] op tag:', opTlv && opTlv.tag.toString(16), 'msgid:', asInteger(messageIdTlv));
        const messageId = asInteger(messageIdTlv);
        if (!opTlv) continue;
        const op = opTlv.tag;
        if (op === 0x60) { // BindRequest
          const [version, name, auth] = parseSequence(opTlv.value);
          const dn = asString(name);
          const password = auth && auth.tag === 0x80 ? asString(auth) : '';
          let ok = true;
          if (dn === bindDn) ok = password === bindPassword;
          else {
            const user = users.find((u) => u.dn === dn);
            ok = !!user && user.password === password;
          }
          socket.write(bindResponse(messageId, ok ? 0 : 49));
        } else if (op === 0x63) { // SearchRequest
          const parts = parseSequence(opTlv.value);
          // parts: [baseObject, scope, deref, sizeLimit, timeLimit, typesOnly, filter, attributes]
          const filterTlv = parts[6];
          const filterParts = filterTlv ? parseSequence(filterTlv.value) : [];
          const attr = filterParts[0] ? asString(filterParts[0]) : '';
          const value = filterParts[1] ? asString(filterParts[1]) : '';
          const matches = users.filter((u) => {
            const entryVal = u.attributes[attr];
            return (Array.isArray(entryVal) ? entryVal : [entryVal]).some((v) => String(v) === value);
          });
          for (const entry of matches) socket.write(searchResultEntry(messageId, entry));
          socket.write(searchResultDone(messageId, 0));
        } else if (op === 0x42) { // UnbindRequest
          socket.end();
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
