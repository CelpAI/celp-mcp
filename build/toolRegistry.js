"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.functionHandlers = void 0;
exports.registerTool = registerTool;
exports.getOpenAIFunctionSpecs = getOpenAIFunctionSpecs;
exports.getOpenAIFunctionSpecsLegacy = getOpenAIFunctionSpecsLegacy;
const zod_1 = require("zod");
const zod_to_json_schema_1 = require("zod-to-json-schema");
const registry = [];
exports.functionHandlers = {};
function registerTool(server, name, description, schema, handler) {
    // Register with MCP server as usual
    server.tool(name, description, schema, handler);
    // Store in our registry for OpenAI function calling
    registry.push({ name, description, schema, handler });
    exports.functionHandlers[name] = handler;
}
function getOpenAIFunctionSpecs() {
    return registry.map(({ name, description, schema }) => ({
        type: "function",
        function: {
            name,
            description,
            parameters: {
                // Convert Zod object schema to JSON Schema for OpenAI
                ...(0, zod_to_json_schema_1.zodToJsonSchema)(zod_1.z.object(schema)),
                // Ensure root type is object as required by OpenAI
                type: "object",
            },
        },
    }));
}
// Legacy function format for backwards compatibility
function getOpenAIFunctionSpecsLegacy() {
    return registry.map(({ name, description, schema }) => ({
        name,
        description,
        parameters: {
            // Convert Zod object schema to JSON Schema for OpenAI
            ...(0, zod_to_json_schema_1.zodToJsonSchema)(zod_1.z.object(schema)),
            // Ensure root type is object as required by OpenAI
            type: "object",
        },
    }));
}
