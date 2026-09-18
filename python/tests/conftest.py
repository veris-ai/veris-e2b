"""Shared fakes: a control plane on a mock transport, and a sandbox that records."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest

from veris_e2b.control_plane import AsyncControlPlane, ControlPlane

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture
def control_plane() -> Callable[[Handler], ControlPlane]:
    def build(handler: Handler) -> ControlPlane:
        return ControlPlane(
            api_key="k",
            api_base="https://svc.api.veris.ai",
            sdk_version="9.9.9",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )

    return build


@pytest.fixture
def async_control_plane() -> Callable[[Handler], AsyncControlPlane]:
    def build(handler: Handler) -> AsyncControlPlane:
        return AsyncControlPlane(
            api_key="k",
            api_base="https://svc.api.veris.ai",
            sdk_version="9.9.9",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

    return build


class FakeCommands:
    """Records every command and answers from a scripted map."""

    def __init__(self, answers: dict[str, tuple[str, str]] | None = None) -> None:
        self.answers = answers or {}
        self.ran: list[str] = []

    def run(self, cmd: str, **_: Any) -> Any:
        self.ran.append(cmd)
        stdout, stderr = next((v for k, v in self.answers.items() if k in cmd), ("", ""))
        return type("Result", (), {"stdout": stdout, "stderr": stderr})()


class FakeSandbox:
    """The narrow slice of an e2b sandbox the Veris layer touches."""

    def __init__(self, answers: dict[str, tuple[str, str]] | None = None) -> None:
        self.commands = FakeCommands(answers)
        self.networks: list[dict[str, Any]] = []
        self.sandbox_id = "e2b_sbx"

    def update_network(self, network: dict[str, Any]) -> None:
        self.networks.append(network)

    def get_host(self, port: int) -> str:
        return f"{port}-sbx.e2b.app"


@pytest.fixture
def fake_sandbox() -> Callable[..., FakeSandbox]:
    """A sandbox stand-in whose commands answer from a scripted map."""

    def build(answers: dict[str, tuple[str, str]] | None = None) -> FakeSandbox:
        return FakeSandbox(answers)

    return build
