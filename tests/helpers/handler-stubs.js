// Shared module-stub helper for handler unit tests.
// Extracts the require.cache / Module._resolveFilename interception that the
// backup-lambda and filter-lambda handler tests previously duplicated.
// Validates: Requirement 45.6 (duplicated stubbing preamble extracted to a helper).

const Module = require('node:module');

/**
 * Install require() stubs for the given module id -> export map, load the
 * handler module fresh, and return it together with a restore() that undoes
 * every interception and clears the require cache.
 *
 * Usage:
 *   const { handler, restore } = loadWithStubs('../../backup-lambda/index.js', stubs);
 *   try { ... } finally { restore(); }
 */
function loadWithStubs(handlerRelPath, stubs) {
  const originalResolve = Module._resolveFilename;
  const originalLoad = Module._load;
  const stubbed = new Set(Object.keys(stubs));

  Module._load = function (request, parent, isMain) {
    if (stubbed.has(request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };

  const path = require('node:path');
  const abs = path.resolve(__dirname, handlerRelPath);
  delete require.cache[abs];
  let mod;
  try {
    mod = require(abs);
  } finally {
    // Leave the loader hook in place only while requiring; restore immediately.
    Module._load = originalLoad;
    Module._resolveFilename = originalResolve;
  }

  const restore = () => {
    delete require.cache[abs];
  };

  return { mod, restore };
}

module.exports = { loadWithStubs };
