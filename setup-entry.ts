import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { vauxrPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(vauxrPlugin);
