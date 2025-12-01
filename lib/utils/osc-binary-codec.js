/**
 * OSC Binary Encoding/Decoding utilities
 * Ported from TypeScript version
 */

/**
 * Encode values into binary OSC packet
 * Based on TypeScript implementation
 */
function encodeOSCBinary(path, values, typeInfo) {
  typeInfo = typeInfo || null;
  let typeTag = ",";
  const encodedParts = [];
  const valueBuffers = [];

  // Determine types and encode values
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    let oscType;

    // If we have type info, use it
    if (typeInfo) {
      if (typeInfo.isArray && typeInfo.structure) {
        const elementType = typeInfo.structure[i];
        if (elementType && elementType.type === "primitive") {
          oscType = elementType.oscType;
        } else if (
          elementType &&
          elementType.type === "array" &&
          elementType.elements &&
          elementType.elements[0]
        ) {
          oscType = elementType.elements[0].oscType;
        } else {
          oscType = typeInfo.baseType || "f";
        }
      } else if (i === 0) {
        oscType = typeInfo.baseType || "f";
      } else {
        oscType = typeInfo.baseType || "f";
      }
    } else {
      // Infer type from value if not provided
      if (value === null || value === undefined) {
        oscType = typeInfo?.baseType === "I" ? "I" : "N";
      } else if (typeof value === "number") {
        oscType = Number.isInteger(value) ? "i" : "f";
      } else if (typeof value === "string") {
        oscType = "s";
      } else if (typeof value === "boolean") {
        oscType = value ? "T" : "F";
      } else if (Array.isArray(value)) {
        oscType = "b";
      } else {
        oscType = "f"; // Default to float
      }
    }

    typeTag += oscType;

    // Encode value based on type
    let encodedValue;
    switch (oscType) {
      case "i": // int32
        encodedValue = Buffer.allocUnsafe(4);
        encodedValue.writeInt32BE(Math.floor(value), 0);
        valueBuffers.push(encodedValue);
        break;

      case "f": // float32
        encodedValue = Buffer.allocUnsafe(4);
        encodedValue.writeFloatBE(value, 0);
        valueBuffers.push(encodedValue);
        break;

      case "d": // double
        encodedValue = Buffer.allocUnsafe(8);
        encodedValue.writeDoubleBE(value, 0);
        valueBuffers.push(encodedValue);
        break;

      case "s": // string
      case "S": // symbol
        const strBytes = Buffer.from(String(value), "utf8");
        const strPadded = Buffer.alloc(
          Math.ceil((strBytes.length + 1) / 4) * 4
        );
        strBytes.copy(strPadded);
        valueBuffers.push(strPadded);
        break;

      case "b": // blob
        const blobData = Array.isArray(value)
          ? Buffer.from(value)
          : Buffer.alloc(0);
        const blobSize = Buffer.allocUnsafe(4);
        blobSize.writeInt32BE(blobData.length, 0);
        valueBuffers.push(blobSize);
        const blobPadded = Buffer.alloc(Math.ceil(blobData.length / 4) * 4);
        blobData.copy(blobPadded);
        valueBuffers.push(blobPadded);
        break;

      case "h": // int64
        const int64Value = BigInt(value);
        encodedValue = Buffer.allocUnsafe(8);
        encodedValue.writeInt32BE(Number(int64Value >> 32n), 0);
        encodedValue.writeInt32BE(Number(int64Value & 0xffffffffn), 4);
        valueBuffers.push(encodedValue);
        break;

      case "t": // timetag
        const timestamp = typeof value === "number" ? value : Date.now();
        encodedValue = Buffer.allocUnsafe(8);
        const seconds = Math.floor(timestamp);
        const fraction = Math.floor((timestamp - seconds) * 4294967296);
        encodedValue.writeUInt32BE(seconds, 0);
        encodedValue.writeUInt32BE(fraction, 4);
        valueBuffers.push(encodedValue);
        break;

      case "c": // char
        encodedValue = Buffer.allocUnsafe(4);
        const charCode =
          typeof value === "string" ? value.charCodeAt(0) : value;
        encodedValue.writeInt32BE(charCode, 0);
        valueBuffers.push(encodedValue);
        break;

      case "r": // RGBA
        // Expect hex string like "#RRGGBBAA" or array [r, g, b, a]
        let rgba;
        if (typeof value === "string" && value.startsWith("#")) {
          rgba = [
            parseInt(value.slice(1, 3), 16),
            parseInt(value.slice(3, 5), 16),
            parseInt(value.slice(5, 7), 16),
            parseInt(value.slice(7, 9) || "FF", 16),
          ];
        } else if (Array.isArray(value)) {
          rgba = value.map((v) => Math.round(v * 255)).slice(0, 4);
          while (rgba.length < 4) rgba.push(255);
        } else {
          rgba = [0, 0, 0, 255];
        }
        encodedValue = Buffer.from(rgba);
        valueBuffers.push(encodedValue);
        break;

      case "m": // MIDI
        const midiArray = Array.isArray(value) ? value : [0, 0, 0, 0];
        encodedValue = Buffer.allocUnsafe(4);
        encodedValue.writeUInt32BE(
          ((midiArray[0] & 0xff) << 24) |
            ((midiArray[1] & 0xff) << 16) |
            ((midiArray[2] & 0xff) << 8) |
            (midiArray[3] & 0xff),
          0
        );
        valueBuffers.push(encodedValue);
        break;

      case "T": // true
      case "F": // false
      case "N": // nil
      case "I": // impulse
        // No data for these types
        break;

      default:
        // Default to float
        encodedValue = Buffer.allocUnsafe(4);
        encodedValue.writeFloatBE(Number(value) || 0, 0);
        valueBuffers.push(encodedValue);
    }
  }

  // Encode path (null-terminated, padded to 4 bytes)
  const pathBytes = Buffer.from(path, "utf8");
  const pathPadded = Buffer.alloc(Math.ceil((pathBytes.length + 1) / 4) * 4);
  pathBytes.copy(pathPadded);
  encodedParts.push(pathPadded);

  // Encode type tag (null-terminated, padded to 4 bytes)
  const typeTagBytes = Buffer.from(typeTag, "utf8");
  const typeTagPadded = Buffer.alloc(
    Math.ceil((typeTagBytes.length + 1) / 4) * 4
  );
  typeTagBytes.copy(typeTagPadded);
  encodedParts.push(typeTagPadded);

  // Add all value buffers
  encodedParts.push(...valueBuffers);

  // Combine all parts
  return Buffer.concat(encodedParts);
}

/**
 * Parse binary OSC packet
 */
function parseOSCBinary(buffer) {
  try {
    let offset = 0;

    // Read OSC path (null-terminated string, padded to 4-byte boundary)
    let path = "";
    while (offset < buffer.length && buffer[offset] !== 0) {
      path += String.fromCharCode(buffer[offset]);
      offset++;
    }
    offset = Math.ceil((offset + 1) / 4) * 4;

    if (offset >= buffer.length) {
      return null;
    }

    // Read type tag (starts with ',')
    if (buffer[offset] !== 0x2c) {
      return null;
    }
    offset++;

    let typeTag = "";
    while (offset < buffer.length && buffer[offset] !== 0) {
      typeTag += String.fromCharCode(buffer[offset]);
      offset++;
    }
    offset = Math.ceil((offset + 1) / 4) * 4;

    // Parse values based on type tag
    const values = [];
    for (let i = 0; i < typeTag.length && offset < buffer.length; i++) {
      const type = typeTag[i];
      let value;

      switch (type) {
        case "i": // int32
          value = buffer.readInt32BE(offset);
          offset += 4;
          break;
        case "f": // float32
          value = buffer.readFloatBE(offset);
          offset += 4;
          break;
        case "s": // string
        case "S": // symbol
          let str = "";
          while (offset < buffer.length && buffer[offset] !== 0) {
            str += String.fromCharCode(buffer[offset]);
            offset++;
          }
          offset = Math.ceil((offset + 1) / 4) * 4;
          value = str;
          break;
        case "b": // blob
          const blobSize = buffer.readInt32BE(offset);
          offset += 4;
          value = Array.from(buffer.slice(offset, offset + blobSize));
          offset = Math.ceil((offset + blobSize) / 4) * 4;
          break;
        case "d": // double
          value = buffer.readDoubleBE(offset);
          offset += 8;
          break;
        case "h": // int64
          const high = buffer.readInt32BE(offset);
          const low = buffer.readInt32BE(offset + 4);
          value = (BigInt(high) << 32n) | BigInt(low >>> 0);
          offset += 8;
          break;
        case "t": // timetag
          const seconds = buffer.readUInt32BE(offset);
          const fraction = buffer.readUInt32BE(offset + 4);
          value = seconds + fraction / 4294967296.0; // NTP timestamp
          offset += 8;
          break;
        case "c": // char
          value = String.fromCharCode(buffer.readInt32BE(offset));
          offset += 4;
          break;
        case "r": // RGBA
          const r = buffer.readUInt8(offset);
          const g = buffer.readUInt8(offset + 1);
          const b = buffer.readUInt8(offset + 2);
          const a = buffer.readUInt8(offset + 3);
          value = `#${r.toString(16).padStart(2, "0")}${g
            .toString(16)
            .padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a
            .toString(16)
            .padStart(2, "0")}`;
          offset += 4;
          break;
        case "m": // MIDI
          const midi = buffer.readUInt32BE(offset);
          value = [
            (midi >> 24) & 0xff,
            (midi >> 16) & 0xff,
            (midi >> 8) & 0xff,
            midi & 0xff,
          ];
          offset += 4;
          break;
        case "T": // true
          value = true;
          break;
        case "F": // false
          value = false;
          break;
        case "N": // nil
        case "I": // impulse
          value = null;
          break;
        default:
          break;
      }

      if (value !== undefined) {
        values.push(value);
      }
    }

    return {
      PATH: path,
      VALUE: values.length === 1 ? values[0] : values,
      TYPE: typeTag,
    };
  } catch (error) {
    return null;
  }
}

module.exports = {
  encodeOSCBinary,
  parseOSCBinary,
};
