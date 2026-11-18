import { rmSync } from "node:fs"
import { defineConfig } from "tsup"

export default defineConfig((options) => {
  if (!options.watch) {
    rmSync("dist", { recursive: true, force: true })
  }

  return [
    {
      entry: {
        cli: "src/cli.ts",
      },
      format: ["esm"],
      platform: "node",
      target: "node18",
      removeNodeProtocol: false,
      dts: false,
      clean: false,
      sourcemap: true,
      splitting: false,
      shims: false,
    },
    {
      entry: {
        index: "src/index.ts",
      },
      format: ["esm", "cjs"],
      platform: "node",
      target: "node18",
      removeNodeProtocol: false,
      dts: true,
      clean: false,
      sourcemap: true,
      splitting: false,
      shims: false,
    },
  ]
})
