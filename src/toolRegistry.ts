import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface RegisteredTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: any) => Promise<any>;
}

const registry: RegisteredTool[] = [];
export const functionHandlers: Record<string, (args: any) => Promise<any>> = {};

export function registerTool(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: any) => Promise<any>
) {
  // Register with MCP server as usual
  server.tool(name, description, schema, handler);
  
  // Store in our registry for OpenAI function calling
  registry.push({ name, description, schema, handler });
  functionHandlers[name] = handler;
}

export function getOpenAIFunctionSpecs() {
  return registry.map(({ name, description, schema }) => ({
    type: "function" as const,
    function: {
      name,
      description,
      parameters: {
        // Convert Zod object schema to JSON Schema for OpenAI
        ...zodToJsonSchema(z.object(schema)),
        // Ensure root type is object as required by OpenAI
        type: "object" as const,
      },
    },
  }));
}

// Legacy function format for backwards compatibility
export function getOpenAIFunctionSpecsLegacy() {
  return registry.map(({ name, description, schema }) => ({
    name,
    description,
    parameters: {
      // Convert Zod object schema to JSON Schema for OpenAI
      ...zodToJsonSchema(z.object(schema)),
      // Ensure root type is object as required by OpenAI
      type: "object" as const,
    },
  }));
} 