/**
 * Parameter Manager
 * Handles business logic for parameter validation, type checking, and management
 */

const {
  parseNamespace: parseNamespaceUtil,
  extractValue,
} = require("../utils/oscquery-parser");

/**
 * Parameter Manager Class
 * Manages parameter validation, type checking, and parameter data structures
 */
class ParameterManager {
  constructor() {
    this.pathTypeInfo = new Map();
  }

  /**
   * Parse namespace and extract parameters
   * Returns array of parsed nodes, filtering for parameter nodes only
   */
  parseNamespace(namespace) {
    const nodes = parseNamespaceUtil(namespace);

    // Filter for parameter nodes (those with FULL_PATH and TYPE)
    // and store type info for later use
    const parameters = [];
    for (const node of nodes) {
      if (node.fullPath && node.type) {
        parameters.push({
          path: node.fullPath,
          type: node.type,
          value: extractValue(node.value, node.typeInfo),
          range: node.range,
          description: node.description,
          access: node.access,
          typeInfo: node.typeInfo,
        });

        // Store type info for later use in parameter setting
        if (node.typeInfo) {
          this.pathTypeInfo.set(node.fullPath, node.typeInfo);
        }
      }
    }

    return parameters;
  }

  /**
   * Get type info for a path
   */
  getTypeInfo(path, normalizedPath) {
    return this.pathTypeInfo.get(normalizedPath) || this.pathTypeInfo.get(path);
  }

  /**
   * Clear type info
   */
  clearTypeInfo() {
    this.pathTypeInfo.clear();
  }

  /**
   * Helper function to set a nested value in an object based on a path array
   */
  setNestedValue(obj, pathParts, value) {
    let current = obj;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    const lastPart = pathParts[pathParts.length - 1];
    current[lastPart] = value;
  }

  /**
   * Parse path into parts
   */
  parsePath(path) {
    return path.replace(/^\//, "").split("/").filter(Boolean);
  }

  /**
   * Normalize path to ensure it starts with /
   */
  normalizePath(path) {
    const normalized = String(path);
    return normalized.startsWith("/") ? normalized : "/" + normalized;
  }

  /**
   * Convert arguments to value array
   */
  convertToValueArray(args) {
    if (args === null || args === undefined) {
      return [null];
    }
    if (Array.isArray(args)) {
      return args;
    }
    return [args];
  }

  /**
   * Extract expected type from structure item
   */
  extractTypeFromStructure(structureItem, fallbackType) {
    if (structureItem?.type === "array" && structureItem.elements?.[0]) {
      return structureItem.elements[0].oscType;
    }
    if (structureItem?.type === "primitive") {
      return structureItem.oscType;
    }
    return fallbackType;
  }

  /**
   * Extract expected type for a value at given index
   */
  extractExpectedType(typeInfo, index) {
    if (typeInfo.isArray && typeInfo.structure && typeInfo.structure[index]) {
      return this.extractTypeFromStructure(
        typeInfo.structure[index],
        typeInfo.baseType
      );
    }
    return typeInfo.baseType;
  }

  /**
   * Validate length matches expected
   */
  validateLength(actualLength, expectedLength, isArray) {
    if (actualLength !== expectedLength) {
      return {
        valid: false,
        error: `Expected exactly ${expectedLength} value(s) (${
          isArray ? "array" : "single"
        } type), got ${actualLength}`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate all values in array
   */
  validateAllValues(valueArray, typeInfo, expectedLength) {
    for (let i = 0; i < expectedLength; i++) {
      const value = valueArray[i];
      const expectedType = this.extractExpectedType(typeInfo, i);

      if (!expectedType) {
        return {
          valid: false,
          error: `No type information available for value at index ${i}`,
        };
      }

      const typeMatch = this.checkValueType(value, expectedType);
      if (!typeMatch.valid) {
        return {
          valid: false,
          error: `Value at index ${i}: ${typeMatch.error}. Expected exact type: ${expectedType}`,
        };
      }
    }
    return { valid: true };
  }

  /**
   * Validate that incoming arguments match the expected typeInfo format
   */
  validateValueFormat(valueArray, typeInfo) {
    if (!typeInfo) {
      return {
        valid: false,
        error:
          "Type information not available for this parameter. Cannot validate exact type.",
      };
    }

    const expectedLength = typeInfo.length || 1;
    const actualLength = valueArray.length;

    const lengthValidation = this.validateLength(
      actualLength,
      expectedLength,
      typeInfo.isArray
    );
    if (!lengthValidation.valid) {
      return lengthValidation;
    }

    return this.validateAllValues(valueArray, typeInfo, expectedLength);
  }

  /**
   * Validate null/undefined values for nil/impulse types
   */
  validateNullish(value, expectedOscType) {
    if (expectedOscType === "N" || expectedOscType === "I") {
      return { valid: true };
    }
    return {
      valid: false,
      error: `null/undefined not allowed for type ${expectedOscType}`,
    };
  }

  /**
   * Validate int32 type
   */
  validateInt32(value) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return {
        valid: false,
        error: `Expected integer (int32), got ${typeof value}${
          typeof value === "number" ? " (not an integer)" : ""
        }`,
      };
    }
    if (value < -2147483648 || value > 2147483647) {
      return {
        valid: false,
        error: `Integer value ${value} out of int32 range (-2147483648 to 2147483647)`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate float32 type
   */
  validateFloat32(value) {
    if (typeof value !== "number") {
      return {
        valid: false,
        error: `Expected number (float32), got ${typeof value}`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate double type
   */
  validateDouble(value) {
    if (typeof value !== "number") {
      return {
        valid: false,
        error: `Expected number (double), got ${typeof value}`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate string/symbol type
   */
  validateString(value) {
    if (typeof value !== "string") {
      return {
        valid: false,
        error: `Expected string, got ${typeof value}`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate blob type
   */
  validateBlob(value) {
    if (!Array.isArray(value) && !Buffer.isBuffer(value)) {
      return {
        valid: false,
        error: `Expected array or Buffer for blob, got ${typeof value}`,
      };
    }
    if (Array.isArray(value)) {
      for (let j = 0; j < value.length; j++) {
        if (
          typeof value[j] !== "number" ||
          !Number.isInteger(value[j]) ||
          value[j] < 0 ||
          value[j] > 255
        ) {
          return {
            valid: false,
            error: `Blob array must contain integers 0-255, got invalid value at index ${j}`,
          };
        }
      }
    }
    return { valid: true };
  }

  /**
   * Validate int64 type
   */
  validateInt64(value) {
    if (typeof value !== "number" && typeof value !== "bigint") {
      return {
        valid: false,
        error: `Expected number or bigint, got ${typeof value}`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate char type
   */
  validateChar(value) {
    if (typeof value !== "string" || value.length !== 1) {
      return {
        valid: false,
        error: `Expected single character string, got ${typeof value}`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate RGBA type
   */
  validateRGBA(value) {
    if (
      typeof value !== "string" &&
      !Array.isArray(value) &&
      typeof value !== "object"
    ) {
      return {
        valid: false,
        error: `Expected string, array, or object for RGBA, got ${typeof value}`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate MIDI type
   */
  validateMIDI(value) {
    if (!Array.isArray(value)) {
      return {
        valid: false,
        error: `Expected array for MIDI, got ${typeof value}`,
      };
    }
    if (value.length !== 4) {
      return {
        valid: false,
        error: `Expected exactly 4 bytes for MIDI, got ${value.length}`,
      };
    }
    for (let j = 0; j < 4; j++) {
      if (
        typeof value[j] !== "number" ||
        !Number.isInteger(value[j]) ||
        value[j] < 0 ||
        value[j] > 255
      ) {
        return {
          valid: false,
          error: `MIDI byte at index ${j} must be integer 0-255, got ${value[j]}`,
        };
      }
    }
    return { valid: true };
  }

  /**
   * Validate boolean true type
   */
  validateTrue(value) {
    if (value !== true) {
      return {
        valid: false,
        error: `Expected exact boolean true, got ${typeof value} (${value})`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate boolean false type
   */
  validateFalse(value) {
    if (value !== false) {
      return {
        valid: false,
        error: `Expected exact boolean false, got ${typeof value} (${value})`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate nil/impulse type
   */
  validateNil(value, expectedOscType) {
    if (value !== null && value !== undefined) {
      return {
        valid: false,
        error: `Expected null/undefined for ${expectedOscType}, got ${typeof value}`,
      };
    }
    return { valid: true };
  }

  /**
   * Type validator map
   */
  get TYPE_VALIDATORS() {
    return {
      i: this.validateInt32.bind(this),
      f: this.validateFloat32.bind(this),
      d: this.validateDouble.bind(this),
      s: this.validateString.bind(this),
      S: this.validateString.bind(this),
      b: this.validateBlob.bind(this),
      h: this.validateInt64.bind(this),
      c: this.validateChar.bind(this),
      r: this.validateRGBA.bind(this),
      m: this.validateMIDI.bind(this),
      T: this.validateTrue.bind(this),
      F: this.validateFalse.bind(this),
    };
  }

  /**
   * Check if a value matches the expected OSC type
   */
  checkValueType(value, expectedOscType) {
    // Handle null/undefined for nil/impulse types
    if (value === null || value === undefined) {
      return this.validateNullish(value, expectedOscType);
    }

    // Handle nil/impulse types for non-null values
    if (expectedOscType === "N" || expectedOscType === "I") {
      return this.validateNil(value, expectedOscType);
    }

    // Get validator for type
    const validator = this.TYPE_VALIDATORS[expectedOscType];
    if (!validator) {
      // Unknown type, allow it (might be custom)
      return { valid: true };
    }

    return validator(value);
  }

  /**
   * Check if range item has MIN/MAX values
   */
  isMinMaxRange(item) {
    return (
      item && item !== null && item.MIN !== undefined && item.MAX !== undefined
    );
  }

  /**
   * Check if range item has VALS array
   */
  isValsRange(item) {
    return item && item.VALS && Array.isArray(item.VALS);
  }

  /**
   * Process array range
   */
  processArrayRange(rangeArray) {
    return rangeArray.map((rangeItem) => {
      if (this.isMinMaxRange(rangeItem)) {
        return { MIN: rangeItem.MIN, MAX: rangeItem.MAX };
      }
      if (this.isValsRange(rangeItem)) {
        return { VALS: rangeItem.VALS };
      }
      return rangeItem;
    });
  }

  /**
   * Process object range
   */
  processObjectRange(rangeObj) {
    const processed = {};
    if (rangeObj.MIN !== undefined) processed.MIN = rangeObj.MIN;
    if (rangeObj.MAX !== undefined) processed.MAX = rangeObj.MAX;
    if (Array.isArray(rangeObj.VALS)) processed.VALS = rangeObj.VALS;
    return processed;
  }

  /**
   * Process range information
   */
  processRange(range) {
    if (!range || range === null) {
      return null;
    }

    if (Array.isArray(range)) {
      return this.processArrayRange(range);
    }

    if (typeof range === "object") {
      return this.processObjectRange(range);
    }

    return null;
  }

  /**
   * Build parameter object from parsed parameter
   */
  buildParameterObject(param) {
    const paramObj = {
      type: param.type,
      value:
        param.value !== undefined && param.value !== null ? param.value : null,
    };

    const processedRange = this.processRange(param.range);
    if (processedRange) {
      paramObj.range = processedRange;
    }

    if (param.description) paramObj.description = param.description;
    if (param.access !== undefined) paramObj.access = param.access;

    return paramObj;
  }

  /**
   * Build parameter list as nested objects grouped by path hierarchy
   * Parameters are organized into nested objects based on their path
   * Example: /Transform/position -> { Transform: { position: {...} } }
   */
  buildParameterList(parameters) {
    const paramsTree = {};

    parameters.forEach((param) => {
      const paramObj = this.buildParameterObject(param);
      const pathParts = this.parsePath(param.path);

      if (pathParts.length > 0) {
        this.setNestedValue(paramsTree, pathParts, paramObj);
      }
    });

    return {
      params: paramsTree,
    };
  }
}

module.exports = ParameterManager;
