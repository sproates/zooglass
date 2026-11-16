# Sales authoring example

This design illustration now has a [runnable authored file](../../../../zooglass/docs/examples/configuration/sales.authored.json).
The [accepted design](../../configuration-authoring.md) defines its expansion to the
existing [sales runtime configuration](../../../../zooglass/docs/examples/configuration/sales-sqlite.json).

```json
{
  "format": "zooglass-config/v1",
  "fieldTemplates": {
    "sale": {
      "sourceId": "sales",
      "type": "sale",
      "facts": {
        "revision": "latestFactRevision",
        "maxRetainedFacts": 100,
        "minimumBirthSequence": 1
      }
    }
  },
  "storage": "sqlite",
  "maxStreams": 100,
  "identityWindow": 1000,
  "maxHistoryEntries": 1000,
  "sources": [
    {
      "id": "sales",
      "epoch": "day-1"
    }
  ],
  "views": [
    {
      "id": "sales-summary",
      "fields": {
        "items": {
          "use": "sale",
          "mode": "activeFacts"
        },
        "total": {
          "use": "sale",
          "mode": "sumActiveFacts",
          "property": "amount"
        }
      }
    }
  ]
}
```
