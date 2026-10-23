// Shared by scripts/generate-types.mjs and test/spec.test.ts so the generator
// and the drift check cannot disagree on options.

import openapiTS, { astToString } from "openapi-typescript";

export const TARGETS = [
  {
    spec: "spec/openapi.json",
    out: "src/generated/openapi.ts",
    banner: "// Generated from spec/openapi.json by scripts/generate-types.mjs. Do not edit.\n",
  },
];

/**
 * @param {string} specJson the OpenAPI document as a JSON string
 * @param {{ banner: string }} target
 * @returns {Promise<string>}
 */
export async function generateTypes(specJson, target) {
  const ast = await openapiTS(JSON.parse(specJson), {
    exportType: true,
    alphabetize: true,
    rootTypes: false,
  });
  const body = astToString(ast);
  return `${target.banner}/* eslint-disable */\n\n${body}`;
}
