/**
 * OSCQuery Node Parser
 * Ported from TypeScript version to match parsing logic
 */

/**
 * Parse OSC type string
 */
function parseType(typeStr) {
  if (!typeStr || typeof typeStr !== "string") {
    return {
      baseType: null,
      isArray: false,
      length: 0,
      structure: [],
      raw: "",
    };
  }

  const structure = [];
  let i = 0;
  let currentArray = null;

  while (i < typeStr.length) {
    const char = typeStr[i];

    if (char === "[") {
      currentArray = [];
      i++;
    } else if (char === "]") {
      if (currentArray !== null) {
        structure.push({ type: "array", elements: currentArray });
        currentArray = null;
      }
      i++;
    } else {
      const typeInfo = getTypeInfo(char);
      const structureItem = {
        type: "primitive",
        oscType: typeInfo.oscType,
        info: typeInfo,
      };
      if (currentArray !== null) {
        currentArray.push(structureItem);
      } else {
        structure.push(structureItem);
      }
      i++;
    }
  }

  const isArray = structure.length > 1 || structure[0]?.type === "array";
  const baseType =
    structure[0]?.type === "primitive"
      ? structure[0].oscType
      : structure[0]?.type === "array"
      ? structure[0].elements[0]?.oscType
      : null;

  return {
    baseType: baseType || null,
    isArray,
    length: structure.length,
    structure,
    raw: typeStr,
  };
}

/**
 * Get information about an OSC type character
 */
function getTypeInfo(char) {
  const types = {
    i: { oscType: "i", name: "int32", size: 4, jsType: "number" },
    f: { oscType: "f", name: "float32", size: 4, jsType: "number" },
    s: { oscType: "s", name: "string", size: null, jsType: "string" },
    b: { oscType: "b", name: "blob", size: null, jsType: "Uint8Array" },
    h: { oscType: "h", name: "int64", size: 8, jsType: "bigint" },
    t: { oscType: "t", name: "timetag", size: 8, jsType: "number" },
    d: { oscType: "d", name: "double", size: 8, jsType: "number" },
    S: { oscType: "S", name: "symbol", size: null, jsType: "string" },
    c: { oscType: "c", name: "char", size: 1, jsType: "string" },
    r: { oscType: "r", name: "RGBA", size: 4, jsType: "string" },
    m: { oscType: "m", name: "MIDI", size: 4, jsType: "Uint8Array" },
    T: { oscType: "T", name: "true", size: 0, jsType: "boolean" },
    F: { oscType: "F", name: "false", size: 0, jsType: "boolean" },
    N: { oscType: "N", name: "nil", size: 0, jsType: "null" },
    I: { oscType: "I", name: "impulse", size: 0, jsType: "null" },
  };

  return (
    types[char] || {
      oscType: char,
      name: "unknown",
      size: null,
      jsType: "unknown",
    }
  );
}

/**
 * Normalize RANGE format
 */
function normalizeRange(range, typeInfo) {
  if (!range) return null;

  // If range is an array of numbers [min, max]
  if (
    Array.isArray(range) &&
    range.length === 2 &&
    typeof range[0] === "number"
  ) {
    return [{ MIN: range[0], MAX: range[1] }];
  }

  // If range is an array of objects
  if (Array.isArray(range)) {
    return range.map((r) => {
      // check if r.MIN and r.MAX are undefined or null
      if (typeof r === "object" && r !== null && ("MIN" in r || "MAX" in r)) {
        return r;
      }
      if (typeof r === "object" && r !== null && "VALS" in r) {
        return r; // Enum values
      }
      if (Array.isArray(r)) {
        // Nested array (for complex types)
        const normalized = normalizeRange(r, typeInfo);
        return normalized?.[0] || {};
      }
      return r;
    });
  }

  // If range is a single object
  if (typeof range === "object" && range !== null) {
    if ("MIN" in range || "MAX" in range) {
      return [range];
    }
    if ("VALS" in range) {
      return [range];
    }
  }

  return null;
}

/**
 * Normalize VALUE format
 */
function normalizeValue(value, typeInfo) {
  if (value === null || value === undefined) {
    return value;
  }

  // If it's already in the correct format, return as-is
  if (Array.isArray(value)) {
    return value;
  }

  // For single values, wrap in array if type expects array
  if (typeInfo?.isArray && !Array.isArray(value)) {
    return [value];
  }

  return value;
}

/**
 * Extract value from VALUE array format
 */
function extractValue(value, typeInfo) {
  if (value === null || value === undefined) {
    return value;
  }

  // If it's a single-element array and type is not array, unwrap
  if (Array.isArray(value) && value.length === 1 && !typeInfo?.isArray) {
    return value[0];
  }

  return value;
}

/**
 * Parse a node and extract all attributes
 */
function parseNode(nodeData) {
  if (!nodeData || typeof nodeData !== "object") {
    throw new Error("Invalid node data");
  }

  const data = nodeData;
  const node = {
    type: data.TYPE || null,
    value: data.VALUE,
    range: null,
    description: data.DESCRIPTION,
    access: data.ACCESS,
    fullPath: data.FULL_PATH,
    contents: data.CONTENTS,
    tags: data.TAGS,
    extendedType: data.EXTENDED_TYPE,
    unit: data.UNIT,
    critical: data.CRITICAL,
    clipmode: data.CLIPMODE,
    overloads: undefined,
  };

  // Parse TYPE to extract base type and array information
  if (node.type) {
    node.typeInfo = parseType(node.type);
  }

  // Parse OVERLOADS if present
  if (data.OVERLOADS && Array.isArray(data.OVERLOADS)) {
    node.overloads = data.OVERLOADS.map((overload) => {
      const parsedOverload = {
        type: overload.TYPE,
        value: overload.VALUE,
        range: undefined,
        extendedType: overload.EXTENDED_TYPE,
        unit: overload.UNIT,
        clipmode: overload.CLIPMODE,
      };

      if (parsedOverload.type) {
        parsedOverload.typeInfo = parseType(parsedOverload.type);
      }

      if (overload.RANGE) {
        parsedOverload.range = normalizeRange(
          overload.RANGE,
          parsedOverload.typeInfo
        );
      }

      if (parsedOverload.value !== undefined && parsedOverload.value !== null) {
        parsedOverload.value = normalizeValue(
          parsedOverload.value,
          parsedOverload.typeInfo
        );
      }

      return parsedOverload;
    });
  }

  // Normalize RANGE format
  if (data.RANGE) {
    node.range = normalizeRange(data.RANGE, node.typeInfo);
  }

  // Normalize VALUE format
  if (data.VALUE !== undefined && data.VALUE !== null) {
    node.value = normalizeValue(data.VALUE, node.typeInfo);
  }

  return node;
}

/**
 * Recursively parse a namespace and extract all nodes
 */
function parseNamespaceRecursive(namespace, nodes) {
  const node = parseNode(namespace);
  nodes.push(node);

  if (namespace.CONTENTS) {
    Object.values(namespace.CONTENTS).forEach((child) => {
      parseNamespaceRecursive(child, nodes);
    });
  }
}

/**
 * Parse a namespace and extract all nodes
 */
function parseNamespace(namespace) {
  if (!namespace || typeof namespace !== "object") {
    return [];
  }
  const nodes = [];
  parseNamespaceRecursive(namespace, nodes);
  return nodes;
}

module.exports = {
  parseNamespace,
  parseNode,
  parseType,
  normalizeRange,
  normalizeValue,
  extractValue,
  getTypeInfo,
};
