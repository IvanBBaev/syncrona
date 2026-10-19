---
"@syncrona/fluent": minor
---

Add a native Fluent pack that needs no `@servicenow/sdk`: `nativePack` reads `now.config.json` (or `package.json#now`) the way the SDK does, writes `package_inventory.csv` and zips the built app directory into `<packOutputDir>/<snake_case(name_version)>.zip` with the SDK's entry layout. The archive comes from a dependency-free deterministic zip writer (`createZip`), so packing an unchanged build twice yields identical bytes.
