from __future__ import annotations

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from ...auth import COOKIE_NAME, is_loopback
from ...dependencies import AppDependencies
from ..schemas import AuthStatusResponse, MessageResponse, NetworkSettingsRequest, PasswordRequest
from ..security import (
    CSRF_COOKIE_NAME,
    error_response,
    peer_ip,
    require_csrf,
    require_session,
    set_session_cookies,
)


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get("/api/auth/status", response_model=AuthStatusResponse, tags=["auth"])
    def auth_status(request: Request, response: Response) -> AuthStatusResponse:
        request_ip = peer_ip(request)
        local = is_loopback(request_ip)
        session = deps.auth.read_session(request.cookies.get(COOKIE_NAME), request_ip)
        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
        csrf_token = (
            csrf_cookie
            if session is not None and deps.auth.verify_csrf(session.id, csrf_cookie)
            else None
        )
        if local and session is None:
            cookie_value, new_session = deps.auth.create_session(request_ip, local=True)
            csrf_token = new_session.csrf_token
            set_session_cookies(response, cookie_value, csrf_token)
            session = new_session
        return AuthStatusResponse(
            local=local,
            authenticated=local or session is not None,
            adminPasswordConfigured=deps.auth.admin_password_configured(),
            csrfToken=csrf_token,
            lanWarning=None if local else "仅可信内网使用，请输入游戏设置中的管理员密码。",
            port=deps.settings.port,
        )

    @api.post("/api/auth/login", response_model=MessageResponse, tags=["auth"])
    def login(
        request: Request, payload: PasswordRequest, response: Response
    ) -> MessageResponse | JSONResponse:
        request_ip = peer_ip(request)
        if is_loopback(request_ip):
            return MessageResponse(message="本机访问无需登录。")
        if deps.auth.too_many_failures(request_ip):
            return error_response(429, "LOGIN_RATE_LIMITED", "登录失败次数过多，请稍后再试。")
        if not deps.auth.verify_admin_password(payload.password):
            deps.auth.record_login(request_ip, False)
            deps.logger.info("auth login rejected peer=%s", request_ip)
            return error_response(401, "INVALID_CREDENTIALS", "游戏管理员密码错误。")
        deps.auth.record_login(request_ip, True)
        deps.logger.info("auth login accepted peer=%s", request_ip)
        cookie_value, session = deps.auth.create_session(request_ip, local=False)
        set_session_cookies(response, cookie_value, session.csrf_token)
        return MessageResponse(message="登录成功。")

    @api.post("/api/auth/logout", response_model=MessageResponse, tags=["auth"])
    def logout(request: Request, response: Response) -> MessageResponse | JSONResponse:
        request_ip = peer_ip(request)
        session = require_session(request, deps.auth, request_ip)
        if isinstance(session, JSONResponse):
            return session
        csrf_error = require_csrf(request, deps.auth, session)
        if csrf_error:
            return csrf_error
        deps.auth.delete_session(session.id)
        response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="strict")
        response.delete_cookie(CSRF_COOKIE_NAME, path="/", samesite="strict")
        return MessageResponse(message="已退出登录。")

    @api.put("/api/settings/network", response_model=MessageResponse, tags=["settings"])
    def set_network_settings(
        request: Request, payload: NetworkSettingsRequest
    ) -> MessageResponse | JSONResponse:
        request_ip = peer_ip(request)
        if not is_loopback(request_ip):
            return error_response(403, "LOCAL_ONLY", "监听端口只能从本机修改。")
        session = require_session(request, deps.auth, request_ip)
        if isinstance(session, JSONResponse):
            return session
        csrf_error = require_csrf(request, deps.auth, session)
        if csrf_error:
            return csrf_error
        deps.database.set_setting("network.port", str(payload.port))
        deps.audit.record("config.network", detail={"port": payload.port}, peer_ip=request_ip)
        return MessageResponse(message="监听端口已保存，重启控制台后生效。")

    return api
