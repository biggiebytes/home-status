"""Windows-only startup adjustments for Home Assistant's Linux test harness."""

import pytest_socket


def _keep_windows_asyncio_socket_pair_enabled(*_args, **_kwargs):
    """Do not replace socket.socket; Windows asyncio needs an INET socket pair."""


pytest_socket.disable_socket = _keep_windows_asyncio_socket_pair_enabled
