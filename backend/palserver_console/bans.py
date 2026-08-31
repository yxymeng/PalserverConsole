from __future__ import annotations

from pathlib import Path

from .steam import assert_no_reparse_points


class BanListError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def read_banned_player_ids(install_path: Path) -> list[str]:
    path = install_path / "Pal" / "Saved" / "SaveGames" / "banlist.txt"
    try:
        assert_no_reparse_points(path)
        if not path.exists():
            return []
        if not path.is_file():
            raise BanListError("BAN_LIST_UNAVAILABLE", "The PalServer ban list is not a file.")
        text = path.read_text(encoding="utf-8-sig")
    except BanListError:
        raise
    except (OSError, UnicodeError, ValueError) as error:
        raise BanListError(
            "BAN_LIST_UNAVAILABLE", f"{type(error).__name__}: {error}"
        ) from error

    return list(
        dict.fromkeys(
            line.strip()
            for line in text.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
    )
