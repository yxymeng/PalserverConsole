from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from ..auth import COOKIE_NAME, AuthStore, Session, is_loopback
from ..config import AppSettings
from ..errors import error_payload

CSRF_COOKIE_NAME = "palconsole_csrf"
COOKIE_MAX_AGE = 12 * 60 * 60
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def peer_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def valid_host(request: Request, settings: AppSettings) -> bool:
    hostname = request.url.hostname
    if hostname is None:
        return False
    if hostname.casefold() in {item.casefold() for item in settings.allowed_hosts}:
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return address.is_private or address.is_loopback


def valid_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return False
    parsed = urlsplit(origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.netloc.casefold() == request.url.netloc.casefold()
    )


def require_session(request: Request, auth: AuthStore, request_ip: str) -> Session | JSONResponse:
    session = auth.read_session(request.cookies.get(COOKIE_NAME), request_ip)
    if session is None:
        return error_response(401, "AUTH_REQUIRED", "需要管理员登录。")
    return session


def require_csrf(request: Request, auth: AuthStore, session: Session) -> JSONResponse | None:
    if auth.verify_csrf(session.id, request.headers.get("X-CSRF-Token")):
        return None
    return error_response(403, "CSRF_REJECTED", "CSRF token 无效或缺失。")


def require_authenticated_request(request: Request, auth: AuthStore) -> JSONResponse | None:
    request_ip = peer_ip(request)
    if is_loopback(request_ip):
        return None
    session = require_session(request, auth, request_ip)
    return session if isinstance(session, JSONResponse) else None


def require_write(request: Request, auth: AuthStore) -> JSONResponse | None:
    request_ip = peer_ip(request)
    session = require_session(request, auth, request_ip)
    if isinstance(session, JSONResponse):
        return session
    return require_csrf(request, auth, session)


def require_local_write(request: Request, auth: AuthStore) -> JSONResponse | None:
    if not is_loopback(peer_ip(request)):
        return error_response(403, "LOCAL_ONLY", "此设置只能从服务器本机修改。")
    return require_write(request, auth)


def set_session_cookies(response: Response, cookie_value: str, csrf_token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        cookie_value,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=False,
        samesite="strict",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE_NAME,
        csrf_token,
        max_age=COOKIE_MAX_AGE,
        httponly=False,
        secure=False,
        samesite="strict",
        path="/",
    )


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=error_payload(code, message, status))
