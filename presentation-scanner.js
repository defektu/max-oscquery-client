//
//  Max/MSP Presentation Scanner
//  Scans objects in presentation mode and extracts their information
//
//  Usage in Max:
//    [js presentation-scanner.js]
//    |
//    [route objectlist detail osc varnames json value found]
//    |
//    [objectlist( [outlet 0]  // Object list (dictionary messages)
//    [detail( [outlet 1]      // Detailed info for each object
//    [osc( [outlet 1]         // OSC path generation
//    [varnames( [outlet 0]    // Varname list
//    [json( [outlet 1]        // JSON export
//    [value( [outlet 1]       // Value responses
//    [found( [outlet 1]       // Object found responses
//
//  Note: This uses the [js] object, not [node.script], because it requires
//  direct access to the Max patcher API for scanning objects. However, the
//  code structure follows the same patterns as node.script-based files.
//
//  Inlets: 1 (all messages)
//  Outlets: 2 (outlet 0: object list, outlet 1: detailed info)
//

autowatch = 1;
inlets = 1;
outlets = 2; // outlet 0: object list, outlet 1: detailed info

var patcher = this.patcher;

/**
 * Send data to Max outlet with routing tag
 * Uses classic Dict creation and explicit "dictionary" message
 * Format: outletTo(index, tag, data) where tag identifies the output type
 *
 * Routing tags:
 *   Outlet 0:
 *     - "objectlist" - Object list (dictionary object, like paramsDict in oscquery.client.js)
 *     - "varnames" - Varname count
 *     - "osc_count" - OSC path count
 *   Outlet 1:
 *     - "detail" - Detailed info for each object (dict object)
 *     - "osc" - OSC path generation (dict object)
 *     - "json" - JSON export (string)
 *     - "value" - Value responses (dict object)
 *     - "found" - Object found responses (dict object)
 *     - "varname" - Individual varname (string)
 */
function outletTo(index, tag, data) {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    // Create a Dict from the JS object
    var d = new Dict();
    d.parse(JSON.stringify(data));
    // Send: tag, "dictionary", dictName (classic Max style)
    outlet(index, tag, "dictionary", d.name);
  } else {
    // For primitives, arrays, strings: send tag and value together
    outlet(index, tag, data);
  }
}

/**
 * Get float range from box
 * @param {Object} box - Max box object
 * @param {number} defaultMin - Default minimum value
 * @param {number} defaultMax - Default maximum value
 * @returns {Object} Object with min and max properties
 */
function getFloatRange(box, defaultMin, defaultMax) {
  try {
    const min = box.getattr("min");
    const max = box.getattr("max");
    return {
      min: min !== null && min !== undefined ? min : defaultMin,
      max: max !== null && max !== undefined ? max : defaultMax,
    };
  } catch (e) {
    return { min: defaultMin, max: defaultMax };
  }
}

/**
 * Extract detailed information from an object
 * @param {Object} box - Max box object
 * @param {number} index - Object index
 * @returns {Object} Object information
 */
function getObjectInfo(box, index) {
  const varname = box.getattr("varname") || "unnamed_" + index;
  const info = {
    index: index,
    varname: varname,
    maxclass: box.maxclass,
    type: "unknown",
    min: 0,
    max: 1,
    steps: 0,
    unit: "",
    presentation_rect: box.getattr("presentation_rect"),
  };

  // Get current value
  let currentValue = null;
  try {
    currentValue = box.getvalueof();
    post(
      "Object '" +
        varname +
        "' (" +
        box.maxclass +
        ") current value: " +
        currentValue +
        "\n"
    );
  } catch (e) {
    post(
      "Object '" +
        varname +
        "' (" +
        box.maxclass +
        ") current value: (unable to read)\n"
    );
  }

  // Determine type and range based on object class
  switch (box.maxclass) {
    case "live.dial":
    case "live.slider":
    case "live.numbox":
    case "slider":
    case "dial":
    case "number~":
    case "number":
      info.type = "float";
      const range = getFloatRange(box, 0, 127);
      info.min = range.min;
      info.max = range.max;
      post("  Possible values: range [" + info.min + " to " + info.max + "]\n");
      break;

    case "toggle":
    case "live.toggle":
      info.type = "bool";
      info.min = 0;
      info.max = 1;
      info.steps = 2;
      post("  Possible values: [0, 1] (boolean)\n");
      break;

    case "button":
    case "live.button":
      info.type = "bang";
      post("  Possible values: bang (no value)\n");
      break;

    case "live.menu":
    case "live.tab":
    case "umenu":
      info.type = "enum";
      try {
        const items = box.getattr("items");
        if (items) {
          info.enum_values = items;
          info.steps = items.length;
          post("  Possible values: " + JSON.stringify(items) + "\n");
        } else {
          post("  Possible values: (no items found)\n");
        }
      } catch (e) {
        post("  Possible values: (unable to read items)\n");
      }
      break;

    case "live.text":
      info.type = "text";
      try {
        const modes = box.getattr("mode");
        if (modes === 1) {
          info.type = "bool";
          post("  Possible values: [0, 1] (boolean text mode)\n");
        } else {
          post("  Possible values: text string\n");
        }
      } catch (e) {
        post("  Possible values: text string\n");
      }
      break;

    default:
      info.type = "generic";
      post("  Possible values: (generic type)\n");
  }

  return info;
}

/**
 * Create dictionary object from object info
 * Returns a dict object like oscquery.client.js format
 * @param {Object} obj - Object info
 * @returns {Object} Dictionary object
 */
function createDictObject(obj) {
  const dictObj = {
    varname: obj.varname,
    maxclass: obj.maxclass,
    type: obj.type,
    min: obj.min,
    max: obj.max,
  };

  // Add other optional fields if they exist
  if (obj.steps > 0) {
    dictObj.steps = obj.steps;
  }
  if (obj.unit && obj.unit !== "") {
    dictObj.unit = obj.unit;
  }
  if (obj.enum_values) {
    dictObj.enum_values = obj.enum_values;
  }

  return dictObj;
}

/**
 * Iterate through all presentation objects
 * @param {Function} callback - Called for each box in presentation mode (box, index)
 */
function iteratePresentationObjects(callback) {
  let allBoxes = patcher.firstobject;
  let count = 0;

  while (allBoxes) {
    count++;
    const inPresentation = allBoxes.getattr("presentation");

    if (inPresentation === 1) {
      // Log all live classes
      if (allBoxes.maxclass && allBoxes.maxclass.indexOf("live.") === 0) {
        post(
          "Live class found: " +
            allBoxes.maxclass +
            " (varname: " +
            (allBoxes.getattr("varname") || "unnamed") +
            ")\n"
        );
      }

      callback(allBoxes, count);
    }

    allBoxes = allBoxes.nextobject;
  }
}

// Initialize state object
const state = {
  presentationObjects: [],
};

/**
 * Scan all objects in presentation mode
 * @returns {Array} Array of presentation objects
 */
function scan() {
  state.presentationObjects = [];

  iteratePresentationObjects((box, index) => {
    const objInfo = getObjectInfo(box, index);
    state.presentationObjects.push(objInfo);

    // Output detailed info for each object as dict (like oscquery.client.js)
    const detailDict = {
      index: index,
      varname: objInfo.varname,
      class: objInfo.maxclass,
      type: objInfo.type,
    };
    outletTo(1, "detail", detailDict);
  });

  // Output dictionary object for all objects (like paramsDict in oscquery.client.js)
  const objectsDict = {
    objects: state.presentationObjects.map((obj) => createDictObject(obj)),
  };
  post(
    "About to output objectlist, objects count: " +
      objectsDict.objects.length +
      "\n"
  );
  post("objectlist dict: " + JSON.stringify(objectsDict) + "\n");
  outletTo(0, "objectlist", objectsDict);

  return state.presentationObjects;
}

/**
 * Get info on a specific object by varname
 * @param {string} varname - Variable name
 * @returns {Object|null} Object information or null if not found
 */
function getobject(varname) {
  const box = patcher.getnamed(varname);

  if (box) {
    const inPresentation = box.getattr("presentation");
    if (inPresentation === 1) {
      const info = getObjectInfo(box, -1);
      const foundDict = {
        varname: varname,
        class: info.maxclass,
        type: info.type,
      };
      outletTo(1, "found", jsToDict("found", foundDict));
      return info;
    }
  }

  return null;
}

/**
 * Generate OSC namespace for all objects
 */
function generate_osc_paths() {
  const oscPaths = [];
  let count = 0;

  iteratePresentationObjects((box, index) => {
    count++;
    const varname = box.getattr("varname") || "unnamed_" + count;
    const oscPath = "/" + varname.replace(/\s+/g, "_");

    oscPaths.push({
      path: oscPath,
      varname: varname,
      class: box.maxclass,
    });

    const oscDict = {
      path: oscPath,
      varname: varname,
      class: box.maxclass,
    };
    outletTo(1, "osc", jsToDict("osc", oscDict));
  });

  outletTo(0, "osc_count", jsToDict("osc_count", { count: oscPaths.length }));
}

/**
 * Get current value of an object
 * @param {string} varname - Variable name
 * @returns {*} Current value or null
 */
function getvalue(varname) {
  const box = patcher.getnamed(varname);

  if (box) {
    try {
      const value = box.getvalueof();
      const valueDict = {
        varname: varname,
        value: value,
      };
      outletTo(1, "value", jsToDict("value", valueDict));
      return value;
    } catch (e) {
      // Unable to read value
    }
  }

  return null;
}

/**
 * Set value of an object
 * @param {string} varname - Variable name
 * @param {*} value - Value to set
 */
function setvalue(varname, value) {
  const box = patcher.getnamed(varname);

  if (box) {
    try {
      box.message(value);
    } catch (e) {
      // Unable to set value
    }
  }
}

/**
 * List all available varnames
 */
function list_varnames() {
  const varnames = [];
  let count = 0;

  iteratePresentationObjects((box, index) => {
    const varname = box.getattr("varname");
    if (varname && varname !== "") {
      varnames.push(varname);
      outletTo(1, "varname", varname);
      count++;
    }
  });

  outletTo(0, "varnames", jsToDict("varnames", { count: count }));
}

/**
 * Export as JSON
 */
function export_json() {
  const presentationObjects = [];

  iteratePresentationObjects((box, index) => {
    const info = getObjectInfo(box, index);
    presentationObjects.push(info);
  });

  const json = JSON.stringify(presentationObjects, null, 2);
  outletTo(1, "json", json);
}

// Message handlers (functions are automatically registered as message handlers in Max JS)
/**
 * Handle bang message - triggers scan
 */
function bang() {
  scan();
}

/**
 * Handle any other message
 */
function anything() {
  const args = arrayfromargs(arguments);
  const command = messagename;
  // Command received but not handled - functions like scan, getobject, etc. are handled automatically
}
