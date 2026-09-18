"""What Sandbox.create refuses, and what it refuses before touching the network."""

from __future__ import annotations

import httpx
import pytest

from veris_e2b import AsyncSandbox, Sandbox, VerisOpts
from veris_e2b.errors import MissingCredentialsError, UnsupportedOperationError, VerisError


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any HTTP call from these tests is itself the failure."""

    def explode(*_args, **_kwargs):
        raise AssertionError("no request should be made")

    monkeypatch.setattr(httpx.Client, "request", explode)
    monkeypatch.setattr(httpx.AsyncClient, "request", explode)


class TestCoordinateGuards:
    def test_a_missing_key_names_the_variable(self, monkeypatch):
        monkeypatch.delenv("VERIS_API_KEY", raising=False)
        with pytest.raises(MissingCredentialsError, match="VERIS_API_KEY"):
            Sandbox.create(veris=VerisOpts(environment_id="env_1"))

    def test_a_missing_environment_names_the_variable(self, monkeypatch):
        monkeypatch.delenv("VERIS_ENVIRONMENT_ID", raising=False)
        with pytest.raises(MissingCredentialsError, match="VERIS_ENVIRONMENT_ID"):
            Sandbox.create(veris=VerisOpts(api_key="k"))


class TestOptionGuards:
    def test_snapshot_and_attach_are_refused_together(self):
        with pytest.raises(VerisError, match="mutually exclusive"):
            Sandbox.create(
                veris=VerisOpts(api_key="k", attach_sandbox_id="sb_1", snapshot_id="snap_1")
            )

    def test_proxy_mode_points_at_the_package_that_has_it(self):
        with pytest.raises(VerisError, match="@veris-ai/e2b"):
            Sandbox.create(veris=VerisOpts(api_key="k", environment_id="env_1", mode="proxy"))

    def test_a_plain_dict_works_as_well_as_the_dataclass(self):
        with pytest.raises(VerisError, match="mutually exclusive"):
            Sandbox.create(
                veris={"api_key": "k", "attach_sandbox_id": "sb_1", "snapshot_id": "snap_1"}
            )


class TestAsyncParity:
    async def test_the_async_sandbox_applies_the_same_guards(self):
        with pytest.raises(VerisError, match="mutually exclusive"):
            await AsyncSandbox.create(
                veris=VerisOpts(api_key="k", attach_sandbox_id="sb_1", snapshot_id="snap_1")
            )


class TestFork:
    def test_fork_is_refused_because_clones_would_share_one_twin(self):
        instance = object.__new__(Sandbox)
        with pytest.raises(UnsupportedOperationError, match="share one twin"):
            instance.fork()

    def test_the_async_sandbox_refuses_it_too(self):
        instance = object.__new__(AsyncSandbox)
        with pytest.raises(UnsupportedOperationError):
            instance.fork()
