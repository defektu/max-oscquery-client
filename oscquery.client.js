/**
 * Max/MSP OSCQuery Client
 * A node.script-based external object for connecting to OSCQuery servers
 *
 * Usage in Max:
 *   [node.script oscquery.client.js]
 *   |
 *   [route param change state disconnect]
 *   |
 *   [param( [outlet 0]  // Parameter list
 *   [change( [outlet 1]  // Parameter changes
 *   [state( [outlet 2]  // Connection state
 *   [disconnect( [outlet 3]  // Disconnect bang
 *
 * Note: node.script has only 1 output edge. Data is sent with routing tags:
 *   - "param" for parameter list (outlet 0)
 *   - "change" for parameter changes (outlet 1)
 *   - "state" for connection state (outlet 2)
 *   - "disconnect" for disconnect bang (outlet 3)
 *
 * Inlets: 1 (all messages)
 * Outlets: 1 (with routing tags - use [route] to split)
 */

const maxAPI = require("max-api");

// Import utilities
const {
  parseNamespace: parseNamespaceUtil,
  parseNode,
  extractValue,
} = require("./utils/oscquery-parser");
const { encodeOSCBinary, parseOSCBinary } = require("./utils/osc-binary-codec");
const { httpGet, WebSocketClient } = require("./utils/web-client");

// State management
let baseUrl = null;
let wsClient = null;
let hostInfo = null;
let namespace = null;
let connected = false;
let autoconnect = false;
let timeout = 5000;
let timeoutTimer = null;
let pathTypeInfo = new Map();
let paramsDict = null; // Keep paramsDict in memory
let updateMode = false; // Update mode: true = batch updates (no output), false = output on each update

//parse process.argv's but skip the first 2 arguments
const args = process.argv.slice(2);
maxAPI.post({ args: args });
const updateModeArg = args.find((arg) => arg.startsWith("update_mode="));
updateMode = updateModeArg ? updateModeArg.split("=")[1] === "true" : false;

const urlArg = args.find((arg) => arg.startsWith("url="));
baseUrl = urlArg ? urlArg.split("=")[1] : "http://localhost:5678";

const autoconnectArg = args.find((arg) => arg.startsWith("autoconnect="));
autoconnect = autoconnectArg ? autoconnectArg.split("=")[1] === "true" : false;
maxAPI.post(
  "AUTOINIT: baseUrl: ",
  baseUrl,
  "updateMode: ",
  updateMode,
  "autoconnect: ",
  autoconnect
);

// node.script has only 1 output edge
// We send data with routing tags so Max can route to different destinations
// Format: [tag, ...data] where tag identifies the outlet type
function outletTo(index, ...args) {
  let tag;
  switch (index) {
    case 0:
      tag = "param"; // Parameter list
      break;
    case 1:
      tag = "change"; // Parameter changes
      break;
    case 2:
      tag = "state"; // Connection state
      break;
    case 3:
      tag = "disconnect"; // Disconnect bang
      maxAPI.outlet("disconnect", "bang");
      return;
    case 4:
      tag = "sent"; // Sent parameter
      break;
    default:
      tag = "unknown";
  }
  // Send with routing tag as first argument
  maxAPI.outlet(tag, ...args);
}

// OSC Binary Codec is now imported from utils

// HTTP GET is now imported from utils/web-client

/**
 * Parse namespace using the proper parser utility
 * Returns array of parsed nodes, filtering for parameter nodes only
 */
function parseNamespace(namespace) {
  // Use the proper parser utility
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
        pathTypeInfo.set(node.fullPath, node.typeInfo);
      }
    }
  }

  return parameters;
}

/**
 * Helper function to set a nested value in an object based on a path array
 */
function setNestedValue(obj, pathParts, value) {
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
 * Extract expected type from structure item
 */
function extractTypeFromStructure(structureItem, fallbackType) {
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
function extractExpectedType(typeInfo, index) {
  if (typeInfo.isArray && typeInfo.structure && typeInfo.structure[index]) {
    return extractTypeFromStructure(
      typeInfo.structure[index],
      typeInfo.baseType
    );
  }
  return typeInfo.baseType;
}

/**
 * Validate length matches expected
 */
function validateLength(actualLength, expectedLength, isArray) {
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
function validateAllValues(valueArray, typeInfo, expectedLength) {
  for (let i = 0; i < expectedLength; i++) {
    const value = valueArray[i];
    const expectedType = extractExpectedType(typeInfo, i);

    if (!expectedType) {
      return {
        valid: false,
        error: `No type information available for value at index ${i}`,
      };
    }

    const typeMatch = checkValueType(value, expectedType);
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
function validateValueFormat(valueArray, typeInfo) {
  if (!typeInfo) {
    return {
      valid: false,
      error:
        "Type information not available for this parameter. Cannot validate exact type.",
    };
  }

  const expectedLength = typeInfo.length || 1;
  const actualLength = valueArray.length;

  const lengthValidation = validateLength(
    actualLength,
    expectedLength,
    typeInfo.isArray
  );
  if (!lengthValidation.valid) {
    return lengthValidation;
  }

  return validateAllValues(valueArray, typeInfo, expectedLength);
}

/**
 * Validate null/undefined values for nil/impulse types
 */
function validateNullish(value, expectedOscType) {
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
function validateInt32(value) {
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
function validateFloat32(value) {
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
function validateDouble(value) {
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
function validateString(value) {
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
function validateBlob(value) {
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
function validateInt64(value) {
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
function validateChar(value) {
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
function validateRGBA(value) {
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
function validateMIDI(value) {
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
function validateTrue(value) {
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
function validateFalse(value) {
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
function validateNil(value, expectedOscType) {
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
const TYPE_VALIDATORS = {
  i: validateInt32,
  f: validateFloat32,
  d: validateDouble,
  s: validateString,
  S: validateString,
  b: validateBlob,
  h: validateInt64,
  c: validateChar,
  r: validateRGBA,
  m: validateMIDI,
  T: validateTrue,
  F: validateFalse,
};

/**
 * Check if a value matches the expected OSC type
 */
function checkValueType(value, expectedOscType) {
  // Handle null/undefined for nil/impulse types
  if (value === null || value === undefined) {
    return validateNullish(value, expectedOscType);
  }

  // Handle nil/impulse types for non-null values
  if (expectedOscType === "N" || expectedOscType === "I") {
    return validateNil(value, expectedOscType);
  }

  // Get validator for type
  const validator = TYPE_VALIDATORS[expectedOscType];
  if (!validator) {
    // Unknown type, allow it (might be custom)
    return { valid: true };
  }

  return validator(value);
}

/**
 * Update a parameter value in paramsDict and output the updated dict
 */
function updateParameterValue(path, value) {
  if (!paramsDict || !paramsDict.params) {
    maxAPI.post("paramsDict not initialized");
    return;
  }

  // Parse path and update nested structure
  const pathParts = path.replace(/^\//, "").split("/").filter(Boolean);

  if (pathParts.length === 0) {
    maxAPI.post("Invalid path:", path);
    return;
  }

  // Navigate to the parameter and update its value
  let current = paramsDict.params;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    if (!current[part]) {
      maxAPI.post(`Path segment not found: ${part} in path ${path}`);
      return;
    }
    current = current[part];
  }

  const lastPart = pathParts[pathParts.length - 1];
  if (current[lastPart]) {
    // Update the value
    current[lastPart].value = value;
    // Output updated paramsDict only if update mode is on
    if (updateMode) {
      outletTo(0, paramsDict);
    }
  } else {
    maxAPI.post(`Parameter not found: ${path}`);
  }
}

/**
 * Check if range item has MIN/MAX values
 */
function isMinMaxRange(item) {
  return (
    item && item !== null && item.MIN !== undefined && item.MAX !== undefined
  );
}

/**
 * Check if range item has VALS array
 */
function isValsRange(item) {
  return item && item.VALS && Array.isArray(item.VALS);
}

/**
 * Process array range
 */
function processArrayRange(rangeArray) {
  return rangeArray.map((rangeItem) => {
    if (isMinMaxRange(rangeItem)) {
      return { MIN: rangeItem.MIN, MAX: rangeItem.MAX };
    }
    if (isValsRange(rangeItem)) {
      return { VALS: rangeItem.VALS };
    }
    return rangeItem;
  });
}

/**
 * Process object range
 */
function processObjectRange(rangeObj) {
  const processed = {};
  if (rangeObj.MIN !== undefined) processed.MIN = rangeObj.MIN;
  if (rangeObj.MAX !== undefined) processed.MAX = rangeObj.MAX;
  if (Array.isArray(rangeObj.VALS)) processed.VALS = rangeObj.VALS;
  return processed;
}

/**
 * Process range information
 */
function processRange(range) {
  if (!range || range === null) {
    return null;
  }

  if (Array.isArray(range)) {
    return processArrayRange(range);
  }

  if (typeof range === "object") {
    return processObjectRange(range);
  }

  return null;
}

/**
 * Parse path into parts
 */
function parsePath(path) {
  return path.replace(/^\//, "").split("/").filter(Boolean);
}

/**
 * Build parameter object from parsed parameter
 */
function buildParameterObject(param) {
  const paramObj = {
    type: param.type,
    value:
      param.value !== undefined && param.value !== null ? param.value : null,
  };

  const processedRange = processRange(param.range);
  if (processedRange) {
    paramObj.range = processedRange;
  }

  if (param.description) paramObj.description = param.description;
  if (param.access !== undefined) paramObj.access = param.access;

  return paramObj;
}

/**
 * Output parameter list as nested objects grouped by path hierarchy
 * Uses outlet 0
 * Parameters are organized into nested objects based on their path
 * Example: /Transform/position -> { Transform: { position: {...} } }
 */
function outputParameterList(parameters) {
  const paramsTree = {};

  parameters.forEach((param) => {
    const paramObj = buildParameterObject(param);
    const pathParts = parsePath(param.path);

    if (pathParts.length > 0) {
      setNestedValue(paramsTree, pathParts, paramObj);
    }
  });

  paramsDict = {
    params: paramsTree,
  };
  outletTo(0, paramsDict);
}

/**
 * Connect to OSCQuery server
 */
async function connect(url) {
  if (connected) {
    disconnect();
  }

  try {
    const normalizedUrl = url.replace(/\/$/, "");
    baseUrl = normalizedUrl;

    maxAPI.post(`Connecting to ${normalizedUrl}...`);

    // Fetch namespace
    namespace = await httpGet(normalizedUrl, timeout);

    try {
      hostInfo = await httpGet(`${normalizedUrl}?HOST_INFO`, timeout);
    } catch (e) {
      maxAPI.post("HOST_INFO not available, WebSocket may not be supported");
    }

    // Parse and output parameter list
    const parameters = parseNamespace(namespace);
    outputParameterList(parameters);

    // Connect WebSocket if available
    if (hostInfo && hostInfo.EXTENSIONS && hostInfo.EXTENSIONS.LISTEN) {
      const wsUrl = hostInfo.WS_URL || normalizedUrl.replace(/^http/, "ws");
      await connectWebSocket(wsUrl);
      // Connection state is set inside connectWebSocket after WebSocket opens
    } else {
      maxAPI.post("WebSocket not supported by server");
      connected = true; // Still connected via HTTP
      outletTo(2, "connected");
      maxAPI.post("Connected successfully (HTTP only)");
    }
  } catch (error) {
    maxAPI.post("Connection error:", error.message);
    connected = false;
    outletTo(2, "disconnected");
    throw error;
  }
}

/**
 * Send LISTEN command for a parameter path
 */
function sendListenCommand(path) {
  wsClient.send(
    JSON.stringify({
      COMMAND: "LISTEN",
      DATA: path,
    })
  );
}

/**
 * Set up LISTEN commands for all parameters
 */
function setupListenCommands() {
  if (!namespace) return;

  const parameters = parseNamespace(namespace);
  maxAPI.post(`Setting up LISTEN for ${parameters.length} parameters`);

  parameters.forEach((param) => {
    try {
      sendListenCommand(param.path);
    } catch (sendError) {
      maxAPI.post(`Error sending LISTEN for ${param.path}:`, sendError.message);
    }
  });
}

/**
 * Parse WebSocket message data
 */
function parseWebSocketMessage(data) {
  if (Buffer.isBuffer(data)) {
    const parsed = parseOSCBinary(data);
    if (parsed) {
      return { type: "osc", ...parsed };
    }
    try {
      return { type: "json", data: JSON.parse(data.toString("utf8")) };
    } catch (e) {
      return null;
    }
  }

  if (typeof data === "string") {
    return { type: "json", data: JSON.parse(data) };
  }

  return null;
}

/**
 * Handle JSON message from WebSocket
 */
function handleJSONMessage(messageData) {
  if (messageData.PATH && messageData.VALUE !== undefined) {
    updateParameterValue(messageData.PATH, messageData.VALUE);
    outletTo(1, messageData.PATH, messageData.VALUE);
  } else if (messageData.COMMAND === "LISTEN" && messageData.DATA) {
    maxAPI.post(`Listening to ${messageData.DATA}`);
  }
}

/**
 * Handle WebSocket message
 */
function handleWebSocketMessage(message) {
  if (message.type === "osc") {
    updateParameterValue(message.PATH, message.VALUE);
    outletTo(1, message.PATH, message.VALUE);
    return;
  }

  if (message.type === "json") {
    handleJSONMessage(message.data);
  }
}

/**
 * Create message handler for WebSocket
 */
function createMessageHandler() {
  return (data) => {
    try {
      const message = parseWebSocketMessage(data);
      if (!message) return;

      handleWebSocketMessage(message);
    } catch (error) {
      maxAPI.post("Error processing WebSocket message:", error.message);
    }
  };
}

/**
 * Create connection handlers for WebSocket
 */
function createConnectionHandlers() {
  return {
    onOpen: () => {
      connected = true;
      outletTo(2, "connected");
      maxAPI.post("Connected successfully");
      setupListenCommands();
    },
    onMessage: createMessageHandler(),
    onError: (error) => {
      connected = false;
      outletTo(2, "disconnected");
    },
    onClose: (code, reason) => {
      if (connected) {
        connected = false;
        outletTo(2, "disconnected");
        outletTo(3);
      }
    },
  };
}

/**
 * Connect WebSocket
 */
function connectWebSocket(wsUrl) {
  const handlers = createConnectionHandlers();

  wsClient = new WebSocketClient({
    timeout: timeout,
    logger: (message, ...args) => maxAPI.post(message, ...args),
    ...handlers,
  });

  return wsClient.connect(wsUrl);
}

/**
 * Disconnect from server
 */
function disconnect() {
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }

  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }

  baseUrl = null;
  hostInfo = null;
  namespace = null;
  pathTypeInfo.clear();
  paramsDict = null; // Clear paramsDict on disconnect

  const wasConnected = connected;
  connected = false;
  outletTo(2, "disconnected");

  if (wasConnected) {
    outletTo(3);
  }

  maxAPI.post("Disconnected");
}

/**
 * Convert arguments to value array
 */
function convertToValueArray(args) {
  if (args === null || args === undefined) {
    return [null];
  }
  if (Array.isArray(args)) {
    return args;
  }
  return [args];
}

/**
 * Normalize path to ensure it starts with /
 */
function normalizePath(path) {
  const normalized = String(path);
  return normalized.startsWith("/") ? normalized : "/" + normalized;
}

/**
 * Get type info for a path
 */
function getTypeInfo(path, normalizedPath) {
  return pathTypeInfo.get(normalizedPath) || pathTypeInfo.get(path);
}

/**
 * Validate OSC packet
 */
function validateOSCPacket(packet) {
  if (!Buffer.isBuffer(packet)) {
    throw new Error("OSC encoding failed: result is not a Buffer");
  }
  if (packet.length === 0) {
    throw new Error("OSC encoding failed: empty packet");
  }
}

/**
 * Validate connection state
 */
function validateConnection() {
  if (!baseUrl) {
    throw new Error("Not connected");
  }
  if (!wsClient || !wsClient.isConnected()) {
    throw new Error(
      "WebSocket is not connected. Please ensure the WebSocket connection is established before setting values."
    );
  }
}

/**
 * Validate and encode parameter value
 */
function validateAndEncode(normalizedPath, valueArray, oscTypeInfo) {
  if (!oscTypeInfo) {
    throw new Error(
      `Type information not available for ${normalizedPath}. Cannot send without exact type validation.`
    );
  }

  const validation = validateValueFormat(valueArray, oscTypeInfo);
  if (!validation.valid) {
    throw new Error(
      `Type validation failed for ${normalizedPath}: ${validation.error}`
    );
  }

  const oscPacket = encodeOSCBinary(normalizedPath, valueArray, oscTypeInfo);
  validateOSCPacket(oscPacket);

  return oscPacket;
}

/**
 * Set parameter value via WebSocket
 */
function setParameter(path, ...args) {
  validateConnection();

  const valueArray = convertToValueArray(args);
  const normalizedPath = normalizePath(path);
  const oscTypeInfo = getTypeInfo(path, normalizedPath);

  try {
    const oscPacket = validateAndEncode(
      normalizedPath,
      valueArray,
      oscTypeInfo
    );
    wsClient.send(oscPacket);

    const sentObject = { path: path, value: valueArray };
    outletTo(4, sentObject);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    maxAPI.post(
      `Failed to send value via WebSocket for ${path}:`,
      errorMessage
    );
    throw new Error(`Failed to send value via WebSocket: ${errorMessage}`);
  }
}

/**
 * Request parameter list refresh
 */
async function refreshList() {
  if (!connected || !baseUrl) {
    maxAPI.post("Not connected");
    return;
  }

  try {
    namespace = await httpGet(baseUrl, timeout);
    const parameters = parseNamespace(namespace);
    outputParameterList(parameters);
    maxAPI.post("Parameter list refreshed");
  } catch (error) {
    maxAPI.post("Error refreshing list:", error.message);
  }
}

// Handle messages from Max
maxAPI.addHandler("connect", (url) => {
  connect(url).catch((error) => {
    maxAPI.post("Connect failed:", error.message);
  });
});

maxAPI.addHandler("disconnect", () => {
  disconnect();
});

maxAPI.addHandler("autoconnect", (value) => {
  autoconnect = value ? true : false;
  maxAPI.post("autoconnect: ", autoconnect);
});

maxAPI.addHandler("timeout", (ms) => {
  timeout = parseInt(ms) || 5000;
});

maxAPI.addHandler("refresh_params", () => {
  maxAPI.post("Refreshing parameter list");
  refreshList();
});

// Handler for update mode (batch updates)
// update_mode 1 = enable (batch updates, no output)
// update_mode 0 = disable (output current state)
maxAPI.addHandler("update_mode", (value) => {
  if (!paramsDict) {
    maxAPI.post("paramsDict not initialized");
    return;
  }
  updateMode = value == "true" ? true : false;

  if (updateMode && paramsDict) {
    // Update mode was turned on, output the current state
    outletTo(0, paramsDict);
    maxAPI.post("Update mode enabled, outputting current state");
  } else {
    maxAPI.post("Update mode disabled");
  }
});

// Test handler: ping -> pong
maxAPI.addHandler("ping", () => {
  maxAPI.post("Received ping, sending pong");
  outletTo(5, "pong"); // Sends: param pong
});

maxAPI.addHandler("url", (url) => {
  baseUrl = url;
  // If autoconnect is enabled, connect immediately
  if (autoconnect && baseUrl) {
    connect(baseUrl).catch((error) => {
      maxAPI.post("AutoConnect failed:", error.message);
    });
  }
});

maxAPI.addHandler("send", (path, ...args) => {
  if (path === undefined || args.length === 0) {
    maxAPI.post("Path and value are required");
    return;
  }

  try {
    setParameter(path, ...args);
  } catch (error) {
    // maxAPI.post(`Error in send handler: ${error.message}`);
  }
});

// Handle URL strings directly (connect when receiving URL)
maxAPI.addHandler("anything", (...args) => {
  if (args.length === 0) return;

  const firstArg = args[0];

  // Check if it's a URL string (starts with http:// or https://)
  if (
    typeof firstArg === "string" &&
    (firstArg.startsWith("http://") || firstArg.startsWith("https://"))
  ) {
    connect(firstArg).catch((error) => {
      maxAPI.post("Connect failed:", error.message);
    });
    return;
  } else if (args.length === 1 && typeof firstArg === "string") {
    // Single string might be a path, but we need a value - ignore
    maxAPI.post(
      `Received single argument "${firstArg}", need path and value to set parameter`
    );
  }
});

// Handle autoconnect on initialization
maxAPI.addHandler("bang", () => {
  if (autoconnect && baseUrl) {
    connect(baseUrl).catch((error) => {
      maxAPI.post("AutoConnect failed:", error.message);
    });
  }
});

// Initialize
maxAPI.post("OSCQuery Client initialized");
if (autoconnect && baseUrl) {
  connect(baseUrl).catch((error) => {
    maxAPI.post("AutoConnect failed:", error.message);
  });
}
outletTo(2, "disconnected"); // Initial connection state: disconnected

// Note: Attributes are handled via messages. To use autoconnect:
// 1. Set @autoconnect 1 and @url <url> in Max object attributes
// 2. Or send "autoconnect 1" and "url <url>" messages
// 3. Then send "bang" to trigger autoconnect
