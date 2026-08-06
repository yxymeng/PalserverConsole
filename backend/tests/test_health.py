from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from palserver_console.main import create_app


def test_health_endpoint_returns_m1_status(tmp_path: Path) -> None:
    from palserver_console.config import AppSettings

    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    with TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    payload = cast(dict[str, str], response.json())
    assert payload == {
        "service": "palserver-console",
        "status": "ok",
        "module": "M2",
        "schemaVersion": 2,
    }
