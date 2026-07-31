import pytest
import pytest_socket


pytest_plugins = ["pytest_homeassistant_custom_component"]


@pytest.fixture(autouse=True)
def enable_home_status_custom_integration(enable_custom_integrations):
    """Allow the repository integration to load like an installed component."""
    yield


@pytest.hookimpl(trylast=True)
def pytest_runtest_setup():
    """Permit the local socket pair required by Windows' asyncio event loop."""
    pytest_socket.enable_socket()


@pytest.hookimpl(tryfirst=True)
def pytest_fixture_setup():
    """Re-enable Windows' asyncio socket pair before async fixtures start."""
    pytest_socket.enable_socket()
