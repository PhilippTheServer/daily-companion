"""A minimal feature used to test the operation machinery in isolation."""

from typing import Literal

from pydantic import BaseModel, Field

from app.helpers.endpoints import Context, FeatureApi, command, query
from app.helpers.errors import NotFound
from app.helpers.idempotency import CommandLog
from app.helpers.models import CommandInput, QueryInput
from app.helpers.responses import Outcome

CALLS = {"note": 0}


class NoteMissing(NotFound):
    """The toy's own not-found error."""


class NoteIn(CommandInput):
    text: str = Field(min_length=1, max_length=50, description="What to note.")
    fail: Literal["none", "not_found", "boom"] = "none"


class WriteIn(CommandInput):
    key: str
    fail: bool = False


class NoteOut(BaseModel):
    text: str
    calls: int


class PatchIn(CommandInput):
    a: str | None = None
    b: str | None = None


class PatchOut(BaseModel):
    sent: list[str]


class EchoIn(QueryInput):
    word: str = Field(min_length=1)
    times: int = Field(default=1, ge=1, le=3)


class EchoOut(BaseModel):
    words: list[str]
    source: str


async def note(ctx: Context, data: NoteIn) -> Outcome[NoteOut]:
    if data.fail == "not_found":
        raise NoteMissing("no such note", "text")
    if data.fail == "boom":
        raise RuntimeError("secret detail")
    CALLS["note"] += 1
    return Outcome(
        NoteOut(text=data.text, calls=CALLS["note"]), days={ctx.now.date()}, warnings=["toy"]
    )


async def write_it(ctx: Context, data: WriteIn) -> Outcome[NoteOut]:
    ctx.session.add(CommandLog(idempotency_key=f"toy-{data.key}", command="toy", response={}))
    await ctx.session.flush()
    if data.fail:
        raise NoteMissing("failed after writing", "key")
    return Outcome(NoteOut(text=data.key, calls=0))


async def patch(ctx: Context, data: PatchIn) -> Outcome[PatchOut]:
    return Outcome(PatchOut(sent=sorted(data.model_fields_set - {"idempotency_key"})))


async def echo(ctx: Context, data: EchoIn) -> EchoOut:
    return EchoOut(words=[data.word] * data.times, source=ctx.principal.source)


TOY = FeatureApi(
    name="toy",
    operations=(
        command("note_it", NoteIn, NoteOut, note, "Store a note.", errors=(NoteMissing,)),
        command("write_it", WriteIn, NoteOut, write_it, "Write a row.", errors=(NoteMissing,)),
        command("patch_it", PatchIn, PatchOut, patch, "Report the fields sent."),
        query("echo", EchoIn, EchoOut, echo, "Echo a word.", view="echo"),
        query("secret_echo", EchoIn, EchoOut, echo, "MCP-only echo."),
    ),
)
