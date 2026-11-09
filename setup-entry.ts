import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { vauxrPlugin } from "./src/channel.js";

/** Setup registers channel metadata only; runtime/tool authority belongs to index.ts. */
export default defineSetupPluginEntry(vauxrPlugin);
