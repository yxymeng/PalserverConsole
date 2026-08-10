import json
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from palserver_console import __version__
from palserver_console.main import create_app
from palserver_console.persistence import SCHEMA_VERSION


def test_health_endpoint_returns_m1_status(tmp_path: Path) -> None:
    from palserver_console.config import AppSettings

    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "build-info.json").write_text(
        json.dumps({"frontendVersion": __version__}), encoding="utf-8"
    )
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=static_dir)
    with TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    payload = cast(dict[str, object], response.json())
    assert payload == {
        "service": "palserver-console",
        "status": "ok",
        "module": "M2",
        "schemaVersion": 2,
        "versions": {
            "application": __version__,
            "api": __version__,
            "database": SCHEMA_VERSION,
            "frontend": __version__,
            "parser": distribution_version("palworld-save-tools"),
        },
    }
