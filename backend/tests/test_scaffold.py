from importlib.metadata import version


def test_package_is_installed():
    assert version("daily2-backend") == "0.1.0"
