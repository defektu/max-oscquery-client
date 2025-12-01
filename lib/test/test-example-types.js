/**
 * Test suite for all parameter types from example.json
 * Tests receiving (parsing) and sending (validation/encoding) for each type
 */

const fs = require("fs");
const path = require("path");
const ParameterManager = require("../core/ParameterManager");
const { encodeOSCBinary } = require("../utils/osc-binary-codec");

// Load example.json
const exampleJsonPath = path.join(__dirname, "..", "example.json");
const exampleNamespace = JSON.parse(fs.readFileSync(exampleJsonPath, "utf8"));

// Initialize ParameterManager
const parameterManager = new ParameterManager();

/**
 * Test results tracking
 */
const testResults = {
  passed: 0,
  failed: 0,
  tests: [],
};

function logTest(name, passed, message = "") {
  testResults.tests.push({ name, passed, message });
  if (passed) {
    testResults.passed++;
    console.log(`✅ ${name}`);
  } else {
    testResults.failed++;
    console.error(`❌ ${name}: ${message}`);
  }
}

/**
 * Test 1: Parse namespace from example.json
 */
function testParseNamespace() {
  console.log("\n=== Test 1: Parse Namespace ===");
  try {
    const parameters = parameterManager.parseNamespace(exampleNamespace);
    logTest(
      "Parse namespace",
      parameters.length > 0,
      `Found ${parameters.length} parameters`
    );

    // Verify we found all expected parameters
    const expectedPaths = [
      "/my_effect1/Controls/Myfloat",
      "/my_effect1/Controls/Myint",
      "/my_effect1/Controls/Myxy",
      "/my_effect1/Controls/My3d",
      "/my_effect1/Controls/My4d",
      "/my_effect1/Controls/Mytoggle",
      "/my_effect1/Controls/Mystring",
      "/my_effect1/Controls/Mymenu",
      "/my_effect1/Controls/Mycolor",
      "/my_effect1/Controls/Mytop",
      "/my_effect1/Controls/Mypulse",
      "/my_effect1/Controls/Mymomentary",
      "/my_effect1/Setup/Something",
      "/my_effect1/Setup/Test",
    ];

    const foundPaths = parameters.map((p) => p.path);
    const allFound = expectedPaths.every((path) => foundPaths.includes(path));
    logTest(
      "All expected parameters found",
      allFound,
      `Missing: ${expectedPaths
        .filter((p) => !foundPaths.includes(p))
        .join(", ")}`
    );

    return parameters;
  } catch (error) {
    logTest("Parse namespace", false, error.message);
    return [];
  }
}

/**
 * Test 2: Build parameter list structure
 */
function testBuildParameterList(parameters) {
  console.log("\n=== Test 2: Build Parameter List ===");
  try {
    const paramsDict = parameterManager.buildParameterList(parameters);

    logTest(
      "Build parameter list",
      paramsDict && paramsDict.params,
      "Parameter dictionary created"
    );

    // Verify nested structure
    const hasNested =
      paramsDict.params.my_effect1?.Controls?.Myfloat !== undefined;
    logTest(
      "Nested structure correct",
      hasNested,
      "Parameters organized in nested structure"
    );

    return paramsDict;
  } catch (error) {
    logTest("Build parameter list", false, error.message);
    return null;
  }
}

/**
 * Test 3: Validate and encode float type (f)
 */
function testFloatType() {
  console.log("\n=== Test 3: Float Type (f) - Myfloat ===");
  const path = "/my_effect1/Controls/Myfloat";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for float", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for float",
    typeInfo.baseType === "f",
    `Expected 'f', got '${typeInfo.baseType}'`
  );

  // Test validation
  const validValue = [1.5];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest(
    "Validate float value",
    validation.valid,
    validation.error || "Valid"
  );

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode float",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode float", false, error.message);
  }

  // Test invalid value
  const invalidValidation = parameterManager.validateValueFormat(
    ["not a number"],
    typeInfo
  );
  logTest(
    "Reject invalid float",
    !invalidValidation.valid,
    "Correctly rejected non-number"
  );
}

/**
 * Test 4: Validate and encode int type (i)
 */
function testIntType() {
  console.log("\n=== Test 4: Int Type (i) - Myint ===");
  const path = "/my_effect1/Controls/Myint";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for int", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for int",
    typeInfo.baseType === "i",
    `Expected 'i', got '${typeInfo.baseType}'`
  );

  // Test validation
  const validValue = [42];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest("Validate int value", validation.valid, validation.error || "Valid");

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode int",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode int", false, error.message);
  }

  // Test invalid value (float when int expected)
  const invalidValidation = parameterManager.validateValueFormat(
    [1.5],
    typeInfo
  );
  logTest(
    "Reject float as int",
    !invalidValidation.valid,
    "Correctly rejected float"
  );
}

/**
 * Test 5: Validate and encode multiple floats (ff)
 */
function testMultipleFloatsType() {
  console.log("\n=== Test 5: Multiple Floats Type (ff) - Myxy ===");
  const path = "/my_effect1/Controls/Myxy";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for ff", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for ff",
    typeInfo.baseType === "f" && typeInfo.length === 2,
    `Expected base 'f' length 2, got base '${typeInfo.baseType}' length ${typeInfo.length}`
  );

  // Test validation
  const validValue = [0.5, -0.5];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest("Validate ff value", validation.valid, validation.error || "Valid");

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode ff",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode ff", false, error.message);
  }

  // Test wrong length
  const invalidValidation = parameterManager.validateValueFormat(
    [0.5],
    typeInfo
  );
  logTest(
    "Reject wrong length",
    !invalidValidation.valid,
    "Correctly rejected wrong length"
  );
}

/**
 * Test 6: Validate and encode three floats (fff)
 */
function testThreeFloatsType() {
  console.log("\n=== Test 6: Three Floats Type (fff) - My3d ===");
  const path = "/my_effect1/Controls/My3d";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for fff", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for fff",
    typeInfo.baseType === "f" && typeInfo.length === 3,
    `Expected base 'f' length 3, got base '${typeInfo.baseType}' length ${typeInfo.length}`
  );

  // Test validation
  const validValue = [0.5, 0.25, 0.75];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest("Validate fff value", validation.valid, validation.error || "Valid");

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode fff",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode fff", false, error.message);
  }
}

/**
 * Test 7: Validate and encode four floats (ffff)
 */
function testFourFloatsType() {
  console.log("\n=== Test 7: Four Floats Type (ffff) - My4d ===");
  const path = "/my_effect1/Controls/My4d";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for ffff", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for ffff",
    typeInfo.baseType === "f" && typeInfo.length === 4,
    `Expected base 'f' length 4, got base '${typeInfo.baseType}' length ${typeInfo.length}`
  );

  // Test validation
  const validValue = [0.1, 0.2, 0.3, 0.4];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest("Validate ffff value", validation.valid, validation.error || "Valid");

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode ffff",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode ffff", false, error.message);
  }
}

/**
 * Test 8: Validate and encode boolean false type (F)
 */
function testBooleanFalseType() {
  console.log("\n=== Test 8: Boolean False Type (F) - Mytoggle ===");
  const path = "/my_effect1/Controls/Mytoggle";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for F", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for F",
    typeInfo.baseType === "F",
    `Expected 'F', got '${typeInfo.baseType}'`
  );

  // Test validation
  const validValue = [false];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest("Validate F value", validation.valid, validation.error || "Valid");

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode F",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode F", false, error.message);
  }

  // Test invalid value (true when false expected)
  const invalidValidation = parameterManager.validateValueFormat(
    [true],
    typeInfo
  );
  logTest(
    "Reject true as F",
    !invalidValidation.valid,
    "Correctly rejected true"
  );
}

/**
 * Test 9: Validate and encode string type (s)
 */
function testStringType() {
  console.log("\n=== Test 9: String Type (s) - Mystring ===");
  const path = "/my_effect1/Controls/Mystring";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for s", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for s",
    typeInfo.baseType === "s",
    `Expected 's', got '${typeInfo.baseType}'`
  );

  // Test validation
  const validValue = ["test string"];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest("Validate s value", validation.valid, validation.error || "Valid");

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode s",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode s", false, error.message);
  }

  // Test invalid value
  const invalidValidation = parameterManager.validateValueFormat(
    [123],
    typeInfo
  );
  logTest(
    "Reject non-string",
    !invalidValidation.valid,
    "Correctly rejected non-string"
  );
}

/**
 * Test 10: Validate and encode RGBA color type (r)
 */
function testRGBAType() {
  console.log("\n=== Test 10: RGBA Color Type (r) - Mycolor ===");
  const path = "/my_effect1/Controls/Mycolor";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for r", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for r",
    typeInfo.baseType === "r",
    `Expected 'r', got '${typeInfo.baseType}'`
  );

  // Test validation with hex string
  const validValueHex = ["#ff0000ff"];
  const validationHex = parameterManager.validateValueFormat(
    validValueHex,
    typeInfo
  );
  logTest(
    "Validate r value (hex)",
    validationHex.valid,
    validationHex.error || "Valid"
  );

  // Test validation with array
  const validValueArray = [[255, 0, 0, 255]];
  const validationArray = parameterManager.validateValueFormat(
    validValueArray,
    typeInfo
  );
  logTest(
    "Validate r value (array)",
    validationArray.valid,
    validationArray.error || "Valid"
  );

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValueHex, typeInfo);
    logTest(
      "Encode r",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode r", false, error.message);
  }
}

/**
 * Test 11: Validate and encode nil/impulse type (N)
 */
function testNilType() {
  console.log("\n=== Test 11: Nil/Impulse Type (N) - Mypulse ===");
  const path = "/my_effect1/Controls/Mypulse";
  const typeInfo = parameterManager.getTypeInfo(path, path);

  if (!typeInfo) {
    logTest("Get type info for N", false, "Type info not found");
    return;
  }

  logTest(
    "Get type info for N",
    typeInfo.baseType === "N",
    `Expected 'N', got '${typeInfo.baseType}'`
  );

  // Test validation with null
  const validValue = [null];
  const validation = parameterManager.validateValueFormat(validValue, typeInfo);
  logTest(
    "Validate N value (null)",
    validation.valid,
    validation.error || "Valid"
  );

  // Test encoding
  try {
    const encoded = encodeOSCBinary(path, validValue, typeInfo);
    logTest(
      "Encode N",
      Buffer.isBuffer(encoded) && encoded.length > 0,
      `Encoded ${encoded.length} bytes`
    );
  } catch (error) {
    logTest("Encode N", false, error.message);
  }
}

/**
 * Test 12: Test parameter value updates
 */
function testParameterValueUpdates(paramsDict) {
  console.log("\n=== Test 12: Parameter Value Updates ===");

  if (!paramsDict || !paramsDict.params) {
    logTest("Update parameter value", false, "paramsDict not initialized");
    return;
  }

  // Test updating a float value
  const path = "/my_effect1/Controls/Myfloat";
  const newValue = 1.5;

  // Navigate to parameter
  const pathParts = path.replace(/^\//, "").split("/").filter(Boolean);
  let current = paramsDict.params;
  for (const part of pathParts.slice(0, -1)) {
    current = current[part];
  }
  const paramName = pathParts[pathParts.length - 1];

  if (current[paramName]) {
    const oldValue = current[paramName].value;
    current[paramName].value = newValue;
    logTest(
      "Update parameter value",
      current[paramName].value === newValue,
      `Updated from ${oldValue} to ${newValue}`
    );
  } else {
    logTest("Update parameter value", false, "Parameter not found");
  }
}

/**
 * Test 13: Test range processing
 */
function testRangeProcessing(parameters) {
  console.log("\n=== Test 13: Range Processing ===");

  const myfloatParam = parameters.find(
    (p) => p.path === "/my_effect1/Controls/Myfloat"
  );
  if (!myfloatParam) {
    logTest("Process range", false, "Parameter not found");
    return;
  }

  const processedRange = parameterManager.processRange(myfloatParam.range);
  logTest(
    "Process range",
    processedRange !== null && Array.isArray(processedRange),
    "Range processed correctly"
  );

  if (processedRange && processedRange[0]) {
    const hasMinMax =
      processedRange[0].MIN !== undefined &&
      processedRange[0].MAX !== undefined;
    logTest(
      "Range has MIN/MAX",
      hasMinMax,
      `MIN: ${processedRange[0].MIN}, MAX: ${processedRange[0].MAX}`
    );
  }

  // Test menu range (VALS)
  const mymenuParam = parameters.find(
    (p) => p.path === "/my_effect1/Controls/Mymenu"
  );
  if (mymenuParam) {
    const menuRange = parameterManager.processRange(mymenuParam.range);
    logTest("Process menu range", menuRange !== null, "Menu range processed");

    if (menuRange && menuRange[0] && menuRange[0].VALS) {
      logTest(
        "Menu range has VALS",
        Array.isArray(menuRange[0].VALS),
        `VALS: ${menuRange[0].VALS.join(", ")}`
      );
    }
  }
}

/**
 * Run all tests
 */
function runAllTests() {
  console.log("=".repeat(60));
  console.log("OSCQuery Parameter Type Tests");
  console.log("=".repeat(60));

  // Test 1: Parse namespace
  const parameters = testParseNamespace();

  // Test 2: Build parameter list
  const paramsDict = testBuildParameterList(parameters);

  // Test individual types
  testFloatType();
  testIntType();
  testMultipleFloatsType();
  testThreeFloatsType();
  testFourFloatsType();
  testBooleanFalseType();
  testStringType();
  testRGBAType();
  testNilType();

  // Test value updates
  testParameterValueUpdates(paramsDict);

  // Test range processing
  testRangeProcessing(parameters);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("Test Summary");
  console.log("=".repeat(60));
  console.log(`Total Tests: ${testResults.passed + testResults.failed}`);
  console.log(`✅ Passed: ${testResults.passed}`);
  console.log(`❌ Failed: ${testResults.failed}`);
  console.log(
    `Success Rate: ${(
      (testResults.passed / (testResults.passed + testResults.failed)) *
      100
    ).toFixed(1)}%`
  );

  if (testResults.failed > 0) {
    console.log("\nFailed Tests:");
    testResults.tests
      .filter((t) => !t.passed)
      .forEach((t) => console.log(`  - ${t.name}: ${t.message}`));
  }

  console.log("=".repeat(60));

  // Exit with appropriate code
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runAllTests();
