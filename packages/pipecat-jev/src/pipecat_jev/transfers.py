"""Transport transfer adapters with Twilio auto-hangup ownership release and Daily SIP frames."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from xml.sax.saxutils import escape as xml_escape

import httpx
from loguru import logger
from pipecat.frames.frames import DataFrame, Frame


class TransferExecutionError(RuntimeError):
    """Raised when a telephony transfer fails to execute."""


@dataclass
class TransferContext:
    """Context passed to a `TransferAdapter` or `@ivr.on_transfer` callback."""

    target: str
    mode: str
    node_id: str
    option_id: str
    extracted: dict[str, bool | str] = field(default_factory=dict)
    metadata: dict[str, str] = field(default_factory=dict)
    call_metadata: dict[str, Any] = field(default_factory=dict)
    push_frame: Callable[[Frame], Awaitable[None]] | None = None


class TransferAdapter:
    """Base interface for executing IVR call transfers."""

    uses_ordered_frames: bool = False

    async def execute(self, ctx: TransferContext) -> None:
        raise NotImplementedError


class SimulatedTransferAdapter(TransferAdapter):
    """Safe local adapter for SmallWebRTC / development sessions without PSTN legs."""

    uses_ordered_frames: bool = False

    def __init__(self) -> None:
        self.history: list[TransferContext] = []

    async def execute(self, ctx: TransferContext) -> None:
        self.history.append(ctx)
        logger.info(
            f"[SimulatedTransferAdapter] Simulated transfer to {ctx.target!r} "
            f"(mode={ctx.mode}, option={ctx.option_id}, extracted={ctx.extracted})"
        )


@dataclass
class FallbackDailySIPReferFrame(DataFrame):
    """Fallback ordered SIP REFER frame used when `pipecat-ai[daily]` C-ext is not installed."""

    settings: dict[str, Any] = field(default_factory=dict)


class DailySipTransferAdapter(TransferAdapter):
    """Queues an ordered `DailySIPReferFrame` so Preceding TTS audio finishes before SIP REFER."""

    uses_ordered_frames: bool = True

    def __init__(
        self,
        *,
        session_id: str | None = None,
        refer_frame_cls: type[Frame] | None = None,
    ) -> None:
        self._session_id = session_id
        self._refer_frame_cls = refer_frame_cls

    def _resolve_frame_cls(self) -> type[Any]:
        if self._refer_frame_cls is not None:
            return self._refer_frame_cls
        try:
            from pipecat.transports.daily.transport import DailySIPReferFrame

            return DailySIPReferFrame
        except ImportError:
            return FallbackDailySIPReferFrame

    async def execute(self, ctx: TransferContext) -> None:
        if ctx.push_frame is None:
            raise TransferExecutionError("DailySipTransferAdapter requires ctx.push_frame.")
        frame_cls = self._resolve_frame_cls()
        settings: dict[str, Any] = {
            "toEndPoint": ctx.target,
            **ctx.metadata,
        }
        if self._session_id and "sessionId" not in settings:
            settings["sessionId"] = self._session_id
        await ctx.push_frame(frame_cls(settings=settings))


class TwilioTransferAdapter(TransferAdapter):
    """Redirects an active Twilio call via `<Dial>` after disabling `TwilioFrameSerializer` auto-hangup."""

    uses_ordered_frames: bool = False

    def __init__(
        self,
        *,
        transport: Any | None = None,
        serializer: Any | None = None,
        call_sid: str | None = None,
        account_sid: str | None = None,
        auth_token: str | None = None,
        api_key_sid: str | None = None,
        api_key_secret: str | None = None,
        region: str | None = None,
        edge: str | None = None,
        base_url: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._transport = transport
        self._serializer = serializer
        self._call_sid = call_sid
        self._account_sid = account_sid
        self._auth_token = auth_token
        self._api_key_sid = api_key_sid
        self._api_key_secret = api_key_secret
        self._region = region
        self._edge = edge
        self._base_url = base_url
        self._http_client = http_client

    def _resolve_serializer(self) -> Any | None:
        if self._serializer is not None:
            return self._serializer
        if self._transport is not None:
            params = getattr(self._transport, "_params", None)
            if params is not None:
                return getattr(params, "serializer", None)
        return None

    def _capture_hangup_ownership(self) -> dict[str, Any] | None:
        """Snapshot serializer hangup flags so a failed redirect can take the call back."""
        ser = self._resolve_serializer()
        if ser is None:
            return None
        params = getattr(ser, "_params", None)
        snapshot: dict[str, Any] = {}
        if params is not None and hasattr(params, "auto_hang_up"):
            snapshot["params_auto_hang_up"] = bool(params.auto_hang_up)
        if hasattr(ser, "_hangup_attempted"):
            snapshot["hangup_attempted"] = bool(ser._hangup_attempted)
        return snapshot

    def _restore_hangup_ownership(self, snapshot: dict[str, Any] | None) -> None:
        if not snapshot:
            return
        ser = self._resolve_serializer()
        if ser is None:
            return
        params = getattr(ser, "_params", None)
        if params is not None and "params_auto_hang_up" in snapshot and hasattr(params, "auto_hang_up"):
            params.auto_hang_up = snapshot["params_auto_hang_up"]
        if "hangup_attempted" in snapshot and hasattr(ser, "_hangup_attempted"):
            ser._hangup_attempted = snapshot["hangup_attempted"]

    def release_auto_hangup(self) -> None:
        """Disable automatic Twilio call termination on EndFrame/CancelFrame teardown.

        `_hangup_attempted` is set first so a CancelFrame that observes the serializer
        mid-update still skips `_hang_up_call`.
        """
        ser = self._resolve_serializer()
        if ser is None:
            return
        if hasattr(ser, "_hangup_attempted"):
            ser._hangup_attempted = True
        params = getattr(ser, "_params", None)
        if params is not None and hasattr(params, "auto_hang_up"):
            params.auto_hang_up = False
        if hasattr(ser, "auto_hang_up"):
            try:
                ser.auto_hang_up = False
            except (AttributeError, TypeError) as exc:
                logger.debug(f"Could not set serializer.auto_hang_up directly: {exc}")

    def _build_endpoint(self, account_sid: str, call_sid: str, ser: Any | None) -> str:
        base_url = self._base_url or getattr(ser, "_base_url", None)
        region = self._region or getattr(ser, "_region", None)
        edge = self._edge or getattr(ser, "_edge", None)
        if base_url:
            host = str(base_url).rstrip("/")
        elif region and edge:
            host = f"https://api.{edge}.{region}.twilio.com"
        else:
            host = "https://api.twilio.com"
        return f"{host}/2010-04-01/Accounts/{account_sid}/Calls/{call_sid}.json"

    @staticmethod
    def build_dial_twiml(target: str) -> str:
        clean = target.strip()
        escaped = xml_escape(clean)
        if clean.lower().startswith("sip:"):
            return f"<Response><Dial><Sip>{escaped}</Sip></Dial></Response>"
        return f"<Response><Dial>{escaped}</Dial></Response>"

    async def execute(self, ctx: TransferContext) -> None:
        ser = self._resolve_serializer()
        call_sid = (
            self._call_sid
            or ctx.call_metadata.get("call_sid")
            or getattr(ser, "_call_sid", None)
        )
        account_sid = self._account_sid or getattr(ser, "_account_sid", None)
        auth_token = self._auth_token or getattr(ser, "_auth_token", None)
        api_key_sid = self._api_key_sid or getattr(ser, "_api_key_sid", None)
        api_key_secret = self._api_key_secret or getattr(ser, "_api_key_secret", None)

        if not call_sid or not account_sid:
            raise TransferExecutionError(
                "TwilioTransferAdapter requires `call_sid` and `account_sid` (directly or via TwilioFrameSerializer)."
            )

        if auth_token:
            auth = ( str(account_sid), str(auth_token) )
        elif api_key_sid and api_key_secret:
            auth = ( str(api_key_sid), str(api_key_secret) )
        else:
            raise TransferExecutionError(
                "TwilioTransferAdapter requires `auth_token` or `api_key_sid` + `api_key_secret`."
            )

        endpoint = self._build_endpoint(str(account_sid), str(call_sid), ser)
        twiml = self.build_dial_twiml(ctx.target)

        owns_client = self._http_client is None
        client = self._http_client or httpx.AsyncClient(timeout=8.0)
        # Twilio can accept <Dial> and close the media stream before this POST returns.
        # Release hangup ownership across that whole wait, and take it back if the redirect fails.
        ownership = self._capture_hangup_ownership()
        self.release_auto_hangup()
        try:
            try:
                try:
                    response = await client.post(
                        endpoint,
                        auth=auth,
                        data={"Twiml": twiml},
                    )
                except httpx.HTTPError as exc:
                    raise TransferExecutionError(
                        f"Twilio transfer request failed ({exc.__class__.__name__}): {exc}"
                    ) from exc

                if not response.is_success:
                    detail = response.text[:200]
                    raise TransferExecutionError(
                        f"Twilio transfer failed with status {response.status_code}: {detail}"
                    )
            except Exception:
                self._restore_hangup_ownership(ownership)
                raise
        finally:
            if owns_client:
                await client.aclose()
