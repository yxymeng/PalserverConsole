from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Final

# Backward-compatible aliases are intentionally retained for 0.x API clients.
# The bundled frontend consumes only the canonical camelCase fields. Remove these
# aliases only in a documented breaking API release.
LEGACY_OPERATION_ALIASES: Final = {
    "id": "operationId",
    "error_code": "errorCode",
    "created_at": "createdAt",
    "updated_at": "updatedAt",
    "parent_operation_id": "parentOperationId",
    "target_pids": "targetPids",
    "confirmation_expires_at": "confirmationExpiresAt",
}


def operation_public(operation: Mapping[str, object]) -> dict[str, object]:
    """Expose canonical fields plus the documented 0.x compatibility aliases."""

    result = {
        "operationId": operation.get("id"),
        "kind": operation.get("kind"),
        "state": operation.get("state"),
        "stage": operation.get("stage"),
        "errorCode": operation.get("error_code"),
        "detail": operation.get("detail"),
        "createdAt": operation.get("created_at"),
        "updatedAt": operation.get("updated_at"),
        "parentOperationId": operation.get("parent_operation_id"),
        "targetPids": operation.get("target_pids"),
        "confirmationExpiresAt": operation.get("confirmation_expires_at"),
    }
    for legacy, canonical in LEGACY_OPERATION_ALIASES.items():
        result[legacy] = result[canonical]
    return result


def audit_public(row: Mapping[str, object]) -> dict[str, object]:
    raw_detail = row.get("detail_json")
    try:
        detail = json.loads(str(raw_detail)) if raw_detail else {}
    except json.JSONDecodeError:
        detail = {"raw": str(raw_detail)}
    return {
        "id": row.get("id"),
        "eventType": row.get("event_type"),
        "peerIp": row.get("peer_ip"),
        "result": row.get("result"),
        "detail": detail,
        "createdAt": row.get("created_at"),
        "source": row.get("source"),
        "parserVersion": row.get("parser_version"),
    }
