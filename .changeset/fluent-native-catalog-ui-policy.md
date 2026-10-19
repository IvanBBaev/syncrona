---
"@syncrona/fluent": minor
---

The native Fluent compiler builds `CatalogUiPolicy()` and `CatalogClientScript()` byte for byte as SDK 4.13 does: the `catalog_ui_policy` record with its `catalog_ui_policy_action` rows and the `catalog_script_client` record, with variables named by `item.variables.name` references (or by name) written as `IO:` references, catalog conditions given as encoded queries or template literals, and the SDK's checks of the catalog item or variable set target, the variables' owner, action messages and duplicate action variables.
