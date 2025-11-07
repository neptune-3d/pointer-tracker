import { defineConfig } from "tsdown";

export default defineConfig((options) => ({
  minify: !options.watch,
}));
