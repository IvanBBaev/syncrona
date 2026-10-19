---
"@syncrona/fluent": minor
---

The native Fluent compiler builds `CatalogItemRecordProducer()` byte for byte as SDK 4.13 does: the `sc_cat_item_producer` record with its target table (a name or a `Table()`), its scripts (or the SDK's default comments), redirect and edit options, the catalog item links and its variables, which name the producer's table, with the SDK's check that mapped fields belong to the target table and are mapped only once.
