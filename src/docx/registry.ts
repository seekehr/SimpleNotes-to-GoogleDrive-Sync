import { HandlerRegistry } from "./context.js";
import { registerBlockHandlers } from "./handlers/blocks.js";
import { registerInlineHandlers } from "./handlers/inline.js";
import { registerListHandlers } from "./handlers/lists.js";
import { registerTableHandlers } from "./handlers/table.js";

/** Registry with every supported Markdown construct. Extend by registering more handlers. */
export function createDefaultRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerInlineHandlers(registry);
  registerBlockHandlers(registry);
  registerListHandlers(registry);
  registerTableHandlers(registry);
  return registry;
}
