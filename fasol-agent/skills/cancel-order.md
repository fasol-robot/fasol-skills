# `cancel_order` — cancel a pending or sleeping order

> **Sub-skill of [Fasol Agent](../SKILL.md).** For the cycle-cleanup pattern
> that makes this a hard requirement (not optional), see
> [orders-tp-sl](orders-tp-sl.md).

`DELETE /orders/{order_id}` — cancel one order by ID. Best-effort: a TP/SL
that already triggered and is in-flight to the chain cannot be cancelled.

Requires the `cancel_orders` scope.

## Request

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer $FASOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"coin_address":"..."}' \
  "$FASOL_API_BASE_URL/orders/<ORDER_ID>"
```

The `coin_address` in the body is required — it's a defence against deleting
the wrong order when you have stale IDs.

## Response

```json
{ "data": { "ok": true, "id": "ord_abc123" } }
```

If you omit either the path `:id` or the body `coin_address`, the 400
response now spells out exactly what's missing and includes a minimal
example body (since 2026-05-29):

```jsonc
{
  "error": "missing_id_or_coin_address",
  "message": "DELETE /orders/:id needs both the path param ...",
  "missing": ["body.coin_address"],
  "example": { "coin_address": "<base58 mint>" },
  "docs": "https://github.com/fasol-robot/fasol-skills/blob/main/fasol-agent/skills/cancel-order.md"
}
```

## Idempotence

DELETE on a deactivated / sleeping / already-cancelled order is a no-op and
returns `ok: true`. This is intentional — it lets cleanup loops just iterate
every ID they remember without per-id state checks. See the cycle pattern in
[orders-tp-sl](orders-tp-sl.md).

## Source-kind safety

Cancel only orders you actually own — i.e. orders the server tagged
`source_kind: "agent"` with your `source_id`. Orders from the UI / Telegram
bot (no `source_kind`) belong to the user; orders from alert autobuy
(`source_kind: "alert"`) belong to the alert flow and should only be touched
if you also have the `manage_alerts` scope.

See [list-orders](list-orders.md) for the recognition pattern.
