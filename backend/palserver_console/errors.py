"""Shared API error and freshness contracts for the M8 integration surface."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ErrorDefinition:
    status: int
    retryable: bool


# HTTP status and retry semantics live here instead of being reimplemented in
# each feature route. Unknown feature-specific codes keep their route status.
ERRORS: dict[str, ErrorDefinition] = {
    "INVALID_INPUT": ErrorDefinition(422, False),
    "INVALID_AUTH_INPUT": ErrorDefinition(422, False),
    "GAME_ADMIN_PASSWORD_REQUIRED": ErrorDefinition(403, False),
    "INVALID_HOST": ErrorDefinition(400, False),
    "ORIGIN_REJECTED": ErrorDefinition(403, False),
    "CSRF_REJECTED": ErrorDefinition(403, False),
    "INVALID_CREDENTIALS": ErrorDefinition(401, False),
    "LOGIN_RATE_LIMITED": ErrorDefinition(429, True),
    "OPERATION_IN_PROGRESS": ErrorDefinition(409, True),
    "OPERATION_NOT_FOUND": ErrorDefinition(404, False),
    "CONSOLE_RESTARTED": ErrorDefinition(503, True),
    "REST_TIMEOUT": ErrorDefinition(504, True),
    "REST_CONNECTION_REFUSED": ErrorDefinition(503, True),
    "REST_CONNECTION_ERROR": ErrorDefinition(503, True),
    "REST_SERVER_ERROR": ErrorDefinition(502, True),
    "SNAPSHOT_PENDING": ErrorDefinition(503, True),
    "SNAPSHOT_PARSE_FAILED": ErrorDefinition(503, True),
    "PARSER_TIMEOUT": ErrorDefinition(504, True),
    "CONFIG_CONFLICT": ErrorDefinition(409, False),
    "SERVER_RUNNING": ErrorDefinition(409, False),
    "BACKUP_PATH_INVALID": ErrorDefinition(400, False),
    "BACKUP_INVALID": ErrorDefinition(409, False),
    "ROLLBACK_FAILED": ErrorDefinition(500, False),
}


def definition_for(code: str, status: int) -> ErrorDefinition:
    registered = ERRORS.get(code)
    if registered is not None:
        return registered
    return ErrorDefinition(status=status, retryable=status >= 500 or status == 429)


def error_payload(code: str, message: str, status: int) -> dict[str, object]:
    definition = definition_for(code, status)
    return {
        "errorCode": code,
        "message": message,
        "retryable": definition.retryable,
    }


def freshness(
    *, source: str, observed_at: int, stale: bool = False, error_code: str | None = None
) -> dict[str, object]:
    return {
        "source": source,
        "observedAt": observed_at,
        "stale": stale,
        "errorCode": error_code,
    }
