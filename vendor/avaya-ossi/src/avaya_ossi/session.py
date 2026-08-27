"""Long-lived read-only OSSI session.

Session policy
--------------
- Keep one SSH + ossit session open across commands.
- Do **not** login on every command.
- Each action refreshes an idle timer (default 30 minutes).
- After idle timeout → logoff and drop (frees CM login slot).
- On transport / OSSI error → reconnect and retry once.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass

import paramiko
from paramiko.channel import Channel

from avaya_ossi.config import SessionConfig
from avaya_ossi.io import (
    channel_alive,
    drain_pending,
    drain_until_quiet,
    looks_like_prompt,
    ossi_has_error,
    recv_for,
    send_line,
    strip_ansi,
)
from avaya_ossi.safety import assert_readonly_command


@dataclass(slots=True)
class CommandResult:
    """Outcome of one :meth:`OssiSession.run` call."""

    command: str
    raw: str
    elapsed_seconds: float
    used_existing_session: bool
    did_login: bool
    retried_after_error: bool
    more_pages: int
    error: str | None = None
    truncated_pages: bool = False

    @property
    def ok(self) -> bool:
        return self.error is None and not ossi_has_error(self.raw)

    @property
    def text(self) -> str:
        """ANSI-stripped raw OSSI exchange."""
        return strip_ansi(self.raw)


class OssiSession:
    """
    Thread-safe long-lived OSSI session.

    - Reuse SSH+ossit across commands (no login each time).
    - Idle timer (default 30 min) refreshed on each action → auto logoff.
    - On error → reconnect + retry once.
    """

    def __init__(self, cfg: SessionConfig) -> None:
        self.cfg = cfg
        self._lock = threading.RLock()
        self._client: paramiko.SSHClient | None = None
        self._chan: Channel | None = None
        self._last_activity = 0.0
        self._connected_at = 0.0
        self._login_count = 0
        self._command_count = 0
        self._stop = threading.Event()
        self._watchdog = threading.Thread(
            target=self._idle_watchdog,
            name="ossi-idle-watchdog",
            daemon=True,
        )
        self._watchdog.start()

    @property
    def is_connected(self) -> bool:
        with self._lock:
            return channel_alive(self._client, self._chan)

    @property
    def seconds_since_activity(self) -> float | None:
        with self._lock:
            if not channel_alive(self._client, self._chan) or self._last_activity <= 0:
                return None
            return time.monotonic() - self._last_activity

    @property
    def seconds_until_idle_logoff(self) -> float | None:
        with self._lock:
            if not channel_alive(self._client, self._chan) or self._last_activity <= 0:
                return None
            left = self.cfg.idle_logoff_seconds - (time.monotonic() - self._last_activity)
            return max(0.0, left)

    def status(self) -> dict[str, object]:
        with self._lock:
            idle_left: float | None = None
            since: float | None = None
            alive = channel_alive(self._client, self._chan)
            if alive and self._last_activity > 0:
                since = time.monotonic() - self._last_activity
                idle_left = max(
                    0.0, self.cfg.idle_logoff_seconds - since
                )
            return {
                "connected": alive,
                "host": f"{self.cfg.host}:{self.cfg.port}",
                "username": self.cfg.username,
                "idle_logoff_seconds": self.cfg.idle_logoff_seconds,
                "seconds_since_activity": since,
                "seconds_until_idle_logoff": idle_left,
                "login_count": self._login_count,
                "command_count": self._command_count,
            }

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            self._logoff_and_drop_unlocked(reason="close")
        if self._watchdog.is_alive():
            self._watchdog.join(timeout=2.0)

    def __enter__(self) -> OssiSession:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def run(
        self,
        command: str,
        *,
        retry_on_error: bool = True,
        max_more_pages: int | None = None,
        form_fields: list[str] | None = None,
        more_idle: float | None = None,
    ) -> CommandResult:
        """
        Run one RO OSSI command.

        max_more_pages: override cfg cap for this call (e.g. sample first pages
        of a huge list station). When cap hit, sends ``n`` to stop more?[y].

        form_fields: optional OSSI form values after ``c`` and before ``t``.
        Each entry is a field payload without the leading ``f`` (e.g. ``0001y``)
        or a full ``f…`` line. Used by form commands like ``display alarms``.

        more_idle: seconds of silence after a more?[y] page before treating the
        list as complete. Does not change the command read_timeout. None = default.
        """
        cmd = assert_readonly_command(command)
        with self._lock:
            return self._run_unlocked(
                cmd,
                retry_on_error=retry_on_error,
                max_more_pages=max_more_pages,
                form_fields=form_fields,
                more_idle=more_idle,
            )

    def touch(self) -> None:
        with self._lock:
            if channel_alive(self._client, self._chan):
                self._last_activity = time.monotonic()

    def force_logoff(self) -> None:
        with self._lock:
            self._logoff_and_drop_unlocked(reason="force_logoff")

    def _touch_unlocked(self) -> None:
        self._last_activity = time.monotonic()

    def _idle_watchdog(self) -> None:
        while not self._stop.wait(self.cfg.idle_check_interval):
            with self._lock:
                if not channel_alive(self._client, self._chan):
                    continue
                idle = time.monotonic() - self._last_activity
                if idle >= self.cfg.idle_logoff_seconds:
                    self._logoff_and_drop_unlocked(
                        reason=f"idle>{self.cfg.idle_logoff_seconds:.0f}s"
                    )

    def _ensure_session_unlocked(self) -> tuple[bool, bool]:
        if channel_alive(self._client, self._chan):
            idle = time.monotonic() - self._last_activity
            if idle >= self.cfg.idle_logoff_seconds:
                self._logoff_and_drop_unlocked(reason="idle_on_ensure")
            else:
                return True, False
        self._connect_unlocked()
        return False, True

    def _connect_unlocked(self) -> None:
        self._drop_unlocked()
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        cfg = self.cfg

        def _auth_handler(
            title: str, instructions: str, prompt_list: list[tuple[str, bool]]
        ) -> list[str]:
            del title, instructions
            return [cfg.password for _ in prompt_list]

        try:
            try:
                client.connect(
                    hostname=cfg.host,
                    port=cfg.port,
                    username=cfg.username,
                    password=cfg.password,
                    look_for_keys=False,
                    allow_agent=False,
                    timeout=cfg.connect_timeout,
                    banner_timeout=cfg.banner_timeout,
                    auth_timeout=cfg.connect_timeout,
                )
            except paramiko.AuthenticationException:
                transport = paramiko.Transport((cfg.host, cfg.port))
                transport.banner_timeout = cfg.banner_timeout
                transport.start_client(timeout=cfg.connect_timeout)
                transport.auth_interactive(cfg.username, _auth_handler)
                client._transport = transport  # noqa: SLF001

            chan = client.invoke_shell(term="vt100", width=160, height=50)
        except Exception:
            try:
                client.close()
            except Exception:
                pass
            raise

        time.sleep(0.5)
        banner = recv_for(chan, timeout=8.0, idle=0.8)
        self._enter_ossi_unlocked(chan, banner)
        self._client = client
        self._chan = chan
        self._login_count += 1
        self._connected_at = time.monotonic()
        self._touch_unlocked()

    def _enter_ossi_unlocked(self, chan: Channel, login_banner: str) -> None:
        cfg = self.cfg
        log_parts: list[str] = [login_banner] if login_banner else []
        buf = recv_for(chan, timeout=2.0, idle=0.5)
        if buf:
            log_parts.append(buf)
        combined = "\n".join(log_parts)

        if looks_like_prompt(combined, "Pin", "PIN", "Access Code", "access code") and cfg.pin:
            send_line(chan, cfg.pin)
            time.sleep(0.3)
            buf = recv_for(chan, timeout=6.0, idle=0.7)
            log_parts.append(buf)
            combined = "\n".join(log_parts)

        if not looks_like_prompt(combined, "Terminal Type", "terminal type", "[513]"):
            send_line(chan, "sat")
            time.sleep(0.4)
            buf = recv_for(chan, timeout=8.0, idle=0.8)
            log_parts.append(buf)

        terms = [cfg.ossi_term]
        terms.append("ossi" if cfg.ossi_term == "ossit" else "ossit")

        entered = False
        for term in terms:
            send_line(chan, term)
            time.sleep(0.5)
            buf = recv_for(chan, timeout=10.0, idle=1.0)
            log_parts.append(buf)
            visible = strip_ansi(buf)
            if looks_like_prompt(visible, "INVALID TERMINAL"):
                continue
            if re.search(r"(?m)^t\s*$", visible) or (
                not looks_like_prompt(visible, "Terminal Type") and visible.strip()
            ):
                entered = True
                break

        if not entered:
            raise RuntimeError(
                "Could not enter OSSI terminal.\n" + strip_ansi("\n".join(log_parts))
            )

    def _run_command_unlocked(
        self,
        command: str,
        *,
        max_more_pages: int,
        form_fields: list[str] | None = None,
        more_idle: float | None = None,
    ) -> tuple[str, int, bool]:
        chan = self._chan
        if chan is None:
            raise RuntimeError("No channel")

        # Clear residual more?/d-lines from previous list (desync poison)
        _ = drain_until_quiet(chan, max_wait=2.0, quiet=0.35, stop_more=True)
        send_line(chan, f"c{command}")
        time.sleep(0.15)
        # Form commands (display alarms): wait for form, then ONE packed f-line, then t.
        # FID must be 4 digits (0001y). Short "1y" → CM "not a valid FID format".
        form_prefix = ""
        if form_fields:
            # Wait for input form (short idle). Then f<FID><TAB><value> per field.
            # This CM rejects "0001n" as FID — value MUST be tab-separated.
            form_prefix = recv_for(chan, timeout=3.0, idle=0.35)
            for raw in form_fields:
                s = (raw or "").strip()
                if not s:
                    continue
                if s.lower().startswith("f"):
                    s = s[1:]
                m = re.match(r"^([0-9A-Fa-f]{4})[\t ]*(.*)$", s)
                if m:
                    fid, val = m.group(1), m.group(2)
                    send_line(chan, f"f{fid}\t{val}")
                else:
                    send_line(chan, "f" + s)
                time.sleep(0.03)
            time.sleep(0.08)
        send_line(chan, "t")

        chunks: list[str] = [form_prefix] if form_prefix else []
        deadline = time.monotonic() + self.cfg.read_timeout
        last = time.monotonic()
        last_more_at = 0.0
        last_answered_more_end = 0
        more_pages = 0
        truncated = False
        chan.settimeout(0.35)

        while time.monotonic() < deadline:
            if chan.recv_ready():
                try:
                    data = chan.recv(65535).decode("utf-8", errors="replace")
                except Exception as exc:
                    raise RuntimeError(f"recv failed: {exc}") from exc
                if data:
                    chunks.append(data)
                    last = time.monotonic()
                    joined = strip_ansi("".join(chunks))
                    # CM often sends "more?[y]\\nd00\\nt" in ONE chunk — more? is not at EOL.
                    # Answer every new more?[y] by position (do not require EOL).
                    for m in re.finditer(r"more\?\s*\[y\]", joined, re.I):
                        if m.end() <= last_answered_more_end:
                            continue
                        if more_pages >= max_more_pages:
                            send_line(chan, "n")
                            truncated = True
                        else:
                            send_line(chan, "y")
                            more_pages += 1
                        last_answered_more_end = m.end()
                        last_more_at = time.monotonic()
                        last = time.monotonic()
                        time.sleep(0.05)
                    # Do not stop on "t" — it appears between more? pages
            elif chunks:
                # After more?, do not stop on "t" (it appears mid-page). Wait for quiet.
                # Longer idle after multi-page lists so tail pages are not left on wire.
                # more_idle is per-command (e.g. 3s for list media-gateway) — not global timeout.
                if last_more_at > 0:
                    idle = 1.05 if more_idle is None else max(1.05, float(more_idle))
                else:
                    # display station/vdn: no more? until first f-lines; 0.6s
                    # aborts after the c/t echo (20101 dump was 31 bytes).
                    idle = 0.6 if more_idle is None else max(0.6, float(more_idle))
                if (time.monotonic() - last) >= idle:
                    break
            else:
                time.sleep(0.05)

        raw = "".join(chunks)
        if not raw.strip():
            raise RuntimeError("Empty OSSI response (session may be dead)")

        # Final quiet drain — never leave more?[y] hanging for the next command.
        if truncated or more_pages > 0:
            time.sleep(0.1)
            extra = drain_until_quiet(
                chan,
                max_wait=3.5 if truncated else 1.8,
                quiet=0.45,
                stop_more=True,
            )
            if extra:
                raw += extra

        return raw, more_pages, truncated

    def _run_unlocked(
        self,
        command: str,
        *,
        retry_on_error: bool,
        max_more_pages: int | None,
        form_fields: list[str] | None = None,
        more_idle: float | None = None,
    ) -> CommandResult:
        used_existing = False
        did_login = False
        retried = False
        t0 = time.perf_counter()
        page_cap = (
            max_more_pages if max_more_pages is not None else self.cfg.max_more_pages
        )
        fields = list(form_fields) if form_fields else None

        try:
            used_existing, did_login = self._ensure_session_unlocked()
            raw, more, trunc = self._run_command_unlocked(
                command,
                max_more_pages=page_cap,
                form_fields=fields,
                more_idle=more_idle,
            )
            if retry_on_error and ossi_has_error(raw) and not trunc:
                retried = True
                self._logoff_and_drop_unlocked(reason="ossi_error_retry")
                _, did_login = self._ensure_session_unlocked()
                did_login = True
                raw, more, trunc = self._run_command_unlocked(
                    command,
                    max_more_pages=page_cap,
                    form_fields=fields,
                    more_idle=more_idle,
                )
            self._touch_unlocked()
            self._command_count += 1
            err = None
            if ossi_has_error(raw):
                err = "OSSI returned e-line error"
            return CommandResult(
                command=command,
                raw=raw,
                elapsed_seconds=time.perf_counter() - t0,
                used_existing_session=used_existing and not retried,
                did_login=did_login,
                retried_after_error=retried,
                more_pages=more,
                error=err,
                truncated_pages=trunc,
            )
        except Exception as exc:
            if not retry_on_error:
                return CommandResult(
                    command=command,
                    raw="",
                    elapsed_seconds=time.perf_counter() - t0,
                    used_existing_session=used_existing,
                    did_login=did_login,
                    retried_after_error=False,
                    more_pages=0,
                    error=f"{type(exc).__name__}: {exc}",
                )
            retried = True
            try:
                self._logoff_and_drop_unlocked(reason="exception_retry")
                _, did_login = self._ensure_session_unlocked()
                did_login = True
                raw, more, trunc = self._run_command_unlocked(
                    command,
                    max_more_pages=page_cap,
                    form_fields=fields,
                    more_idle=more_idle,
                )
                self._touch_unlocked()
                self._command_count += 1
                err = "OSSI returned e-line error" if ossi_has_error(raw) else None
                return CommandResult(
                    command=command,
                    raw=raw,
                    elapsed_seconds=time.perf_counter() - t0,
                    used_existing_session=False,
                    did_login=True,
                    retried_after_error=True,
                    more_pages=more,
                    error=err,
                    truncated_pages=trunc,
                )
            except Exception as exc2:
                self._drop_unlocked()
                return CommandResult(
                    command=command,
                    raw="",
                    elapsed_seconds=time.perf_counter() - t0,
                    used_existing_session=False,
                    did_login=did_login,
                    retried_after_error=True,
                    more_pages=0,
                    error=f"{type(exc2).__name__}: {exc2} (after retry; first={exc})",
                )

    def _logoff_and_drop_unlocked(self, *, reason: str) -> None:
        chan = self._chan
        if chan is not None and not chan.closed:
            try:
                send_line(chan, "clogoff")
                time.sleep(0.2)
                send_line(chan, "t")
                time.sleep(0.3)
                buf = recv_for(chan, timeout=3.0, idle=0.5)
                if looks_like_prompt(buf, "Logoff", "logoff", "Proceed"):
                    send_line(chan, "y")
                    _ = recv_for(chan, timeout=2.0, idle=0.4)
            except Exception:
                pass
        self._drop_unlocked()
        _ = reason

    def _drop_unlocked(self) -> None:
        if self._chan is not None:
            try:
                self._chan.close()
            except Exception:
                pass
            self._chan = None
        if self._client is not None:
            try:
                tr = self._client.get_transport()
                if tr is not None:
                    tr.close()
                self._client.close()
            except Exception:
                pass
            self._client = None
