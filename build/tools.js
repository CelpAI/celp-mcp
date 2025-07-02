"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.functionHandlers = exports.getOpenAIFunctionSpecsLegacy = exports.getOpenAIFunctionSpecs = void 0;
// Initialize tools first
require("./initTools");
// Then export the utilities
var toolRegistry_1 = require("./toolRegistry");
Object.defineProperty(exports, "getOpenAIFunctionSpecs", { enumerable: true, get: function () { return toolRegistry_1.getOpenAIFunctionSpecs; } });
Object.defineProperty(exports, "getOpenAIFunctionSpecsLegacy", { enumerable: true, get: function () { return toolRegistry_1.getOpenAIFunctionSpecsLegacy; } });
Object.defineProperty(exports, "functionHandlers", { enumerable: true, get: function () { return toolRegistry_1.functionHandlers; } });
