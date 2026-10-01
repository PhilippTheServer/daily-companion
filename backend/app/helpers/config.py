"""Settings read from the environment, and the running version."""

from functools import lru_cache
from importlib.metadata import version

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Every setting the backend reads; the defaults match the local compose stack."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://daily2:daily2@localhost:55433/daily2"
    keycloak_url: str = "http://localhost:18180"
    keycloak_public_url: str = "http://localhost:18180"
    keycloak_realm: str = "daily2"
    app_client_id: str = "daily2-app"
    mcp_client_id: str = "daily2-mcp"
    owner_sub: str = ""
    mcp_resource_url: str = "http://localhost:18100/mcp"
    mcp_allowed_hosts: list[str] = ["localhost:18100", "127.0.0.1:18100"]
    mcp_allowed_origins: list[str] = ["https://claude.ai", "https://claude.com"]
    default_timezone: str = "Europe/Berlin"
    log_level: str = "INFO"
    log_json: bool = True
    off_search_url: str = "https://search.openfoodfacts.org/search"
    off_product_url: str = "https://world.openfoodfacts.org/api/v2/product"
    off_user_agent: str = "daily (+https://github.com/PhilippTheServer/daily)"
    gym_bro_url: str = ""
    gym_bro_client_id: str = "daily2-gymbro-sync"
    gym_bro_client_secret: str = ""
    gym_bro_interval_seconds: int = 900

    @property
    def keycloak_issuer(self) -> str:
        """The `iss` every accepted token carries."""
        return f"{self.keycloak_public_url}/realms/{self.keycloak_realm}"

    @property
    def keycloak_jwks_uri(self) -> str:
        """Where the realm's signing keys are fetched from (internal URL)."""
        return f"{self.keycloak_url}/realms/{self.keycloak_realm}/protocol/openid-connect/certs"

    @property
    def keycloak_token_url(self) -> str:
        """The realm's token endpoint (internal URL), used for client credentials."""
        return f"{self.keycloak_url}/realms/{self.keycloak_realm}/protocol/openid-connect/token"


@lru_cache
def get_settings() -> Settings:
    """The process-wide settings, read once."""
    return Settings()


def app_version() -> str:
    """The installed package version."""
    return version("daily2-backend")
