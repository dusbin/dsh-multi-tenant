/**
 * WebSocket 帧编解码（仅用于网关下行过滤与测试）。
 *
 * 服务端→浏览器帧为未掩码；支持文本(0x1)/二进制(0x2)/控制帧(0x8+)/分片边界识别。
 * 策略：只对"完整且未分片"的文本帧做负载解析/改写；其余帧（分片、控制、二进制）
 * 原字节透传，保证流协议正确。
 */

/** 解析缓冲区的下一个服务端帧；数据不足返回 null。 */
export function parseServerWsFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  if (mask) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { fin, opcode, payload, consumed: offset + len };
}

/** 编码一个完整的服务端帧（未掩码）。 */
export function encodeServerWsFrame(opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
