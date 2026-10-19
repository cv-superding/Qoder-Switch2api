/** 解析 PE 文件的导入 DLL 列表 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const buf = readFileSync(file);

if (buf.readUInt16LE(0) !== 0x5a4d) {
  console.log("not a PE");
  process.exit(1);
}
const peOffset = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOffset) !== 0x4550) {
  console.log("no PE signature");
  process.exit(1);
}
const coff = peOffset + 4;
const numberOfSections = buf.readUInt16LE(coff + 2);
const optionalHeaderSize = buf.readUInt16LE(coff + 16);
const opt = coff + 20;
const magic = buf.readUInt16LE(opt);
const is64 = magic === 0x20b;

// 数据目录：导入表是第 2 个目录（index 1）
const dataDirOffset = opt + (is64 ? 112 : 96);
const importRva = buf.readUInt32LE(dataDirOffset + 8);
const importSize = buf.readUInt32LE(dataDirOffset + 12);

// 节表
const sectionTable = opt + optionalHeaderSize;
const sections = [];
for (let i = 0; i < numberOfSections; i += 1) {
  const s = sectionTable + i * 40;
  sections.push({
    name: buf.subarray(s, s + 8).toString("utf8").replace(/\0/g, ""),
    virtualSize: buf.readUInt32LE(s + 8),
    virtualAddress: buf.readUInt32LE(s + 12),
    rawSize: buf.readUInt32LE(s + 16),
    rawPointer: buf.readUInt32LE(s + 20),
  });
}

function rvaToOffset(rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
      return s.rawPointer + (rva - s.virtualAddress);
    }
  }
  return null;
}

if (importRva === 0) {
  console.log("no imports");
  process.exit(0);
}

let off = rvaToOffset(importRva);
const dlls = [];
while (off && off + 20 <= buf.length) {
  const originalFirstThunk = buf.readUInt32LE(off);
  const nameRva = buf.readUInt32LE(off + 12);
  const firstThunk = buf.readUInt32LE(off + 16);
  if (nameRva === 0 && originalFirstThunk === 0 && firstThunk === 0) break;
  const nameOff = rvaToOffset(nameRva);
  if (nameOff) {
    let end = nameOff;
    while (end < buf.length && buf[end] !== 0) end += 1;
    dlls.push(buf.subarray(nameOff, end).toString("utf8"));
  }
  off += 20;
}
console.log(dlls.join("\n"));
