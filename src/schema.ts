import { z } from "zod";
import { type Config, configSchema, ignoredSchema, repoSchema } from "./config.ts";

// JSON Schemas for editors, generated from the zod schemas that validate the files
// The tier is narrowed to the tiers in config.yaml, so editors can suggest them
export function renderSchemas(config: Config): Map<string, string> {
  const tiers = Object.keys(config.tiers) as [string, ...string[]];
  const schemas = {
    "config.schema.json": configSchema,
    "repo.schema.json": repoSchema.extend({ tier: z.enum(tiers).describe("Tier from config.yaml") }),
    "ignored.schema.json": ignoredSchema,
  };
  return new Map(
    Object.entries(schemas).map(([file, schema]) => [
      `schemas/${file}`,
      `${JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2)}\n`,
    ]),
  );
}
