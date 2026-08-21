from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ComponentVersions(BaseModel):
    application: str
    api: str
    database: int
    frontend: str
    parser: str


class HealthResponse(BaseModel):
    service: Literal["palserver-console"] = "palserver-console"
    status: Literal["ok"] = "ok"
    module: Literal["M2"] = "M2"
    schemaVersion: Literal[2] = 2
    versions: ComponentVersions


class AuthStatusResponse(BaseModel):
    local: bool
    authenticated: bool
    adminPasswordConfigured: bool
    csrfToken: str | None = None
    lanWarning: str | None = None
    port: int


class PasswordRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class MessageResponse(BaseModel):
    message: str


class WorldReparseResponse(MessageResponse):
    reparseGeneration: int


class NetworkSettingsRequest(BaseModel):
    port: int = Field(ge=1, le=65535)


class ShellStatusResponse(BaseModel):
    source: Literal["console"] = "console"
    observedAt: int
    stale: Literal[False] = False
    errorCode: str | None = None
    module: Literal["M2"] = "M2"
    serverState: Literal["not_configured", "stopped", "running"]
    configured: bool
    pids: list[int]
    executablePath: str | None
    instanceId: str = "default"


class WorldCandidateResponse(BaseModel):
    worldId: str
    worldPath: str
    modifiedAt: int


class ServerSettingsRequest(BaseModel):
    executablePath: str = Field(min_length=1, max_length=2048)
    launchArguments: str = Field(default="", max_length=4096)
    worldId: str | None = Field(default=None, max_length=256)


class ServerSettingsResponse(BaseModel):
    executablePath: str | None
    launchArguments: str
    worldId: str | None = None
    worldPath: str | None = None
    worldCandidates: list[WorldCandidateResponse] = Field(default_factory=list)
    bindingValid: bool = False
    bindingErrorCode: str | None = None


class DiscoveryCandidateResponse(BaseModel):
    libraryPath: str
    installPath: str
    executablePath: str
    manifestValid: bool
    worldCandidates: list[WorldCandidateResponse] = Field(default_factory=list)


class LifecycleRequest(BaseModel):
    countdownSeconds: int = Field(default=30, ge=5, le=300)
    message: str = Field(
        default="服务器将在 30 秒后维护，请及时返回安全地点。", min_length=1, max_length=500
    )


class LiveActionRequest(BaseModel):
    message: str = Field(default="由管理员发起的服务器管理操作。", min_length=1, max_length=500)


class AuditRetentionRequest(BaseModel):
    retentionDays: int = Field(ge=0, le=3650)


class BackupRetentionRequest(BaseModel):
    retention: int | None = Field(default=None, ge=0, le=100000)


class CleanupConfirmationRequest(BaseModel):
    previewToken: str = Field(min_length=16, max_length=256)


class ConfigApplyRequest(BaseModel):
    force: bool = False


class NotificationSettingsRequest(BaseModel):
    enabled: bool = False
    webhookUrl: str | None = Field(default=None, max_length=2048)
    secret: str | None = Field(default=None, max_length=4096)


class NotificationStatusResponse(BaseModel):
    enabled: bool
    configured: bool


class SteamCmdUpdateRequest(BaseModel):
    steamCmdPath: str = Field(min_length=1, max_length=2048)
    confirmation: Literal["UPDATE"]
    countdownSeconds: int = Field(default=30, ge=5, le=600)
    message: str = Field(
        default="服务器将进行维护更新，请及时返回安全地点。", min_length=1, max_length=500
    )


ApiOperationKind = Literal["start", "save", "stop", "restart"]
