"""WebSocket connection manager for observatory live updates."""
from __future__ import annotations

import asyncio

from fastapi import WebSocket


class ConnectionManager:
    """Track WebSocket clients and their channel subscriptions."""

    def __init__(self) -> None:
        self.active_connections: dict[WebSocket, set[str]] = {}
        self._connection_loops: dict[WebSocket, asyncio.AbstractEventLoop] = {}

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections[websocket] = set()
        self._connection_loops[websocket] = asyncio.get_running_loop()

    def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.pop(websocket, None)
        self._connection_loops.pop(websocket, None)

    def subscribe(self, websocket: WebSocket, channels: list[str]) -> None:
        if websocket in self.active_connections:
            self.active_connections[websocket].update(channels)

    def schedule_on_connection_loop(self, coroutine) -> bool:
        """Schedule a broadcast from a synchronous worker without blocking it."""
        for connection_loop in set(self._connection_loops.values()):
            if connection_loop.is_running():
                future = asyncio.run_coroutine_threadsafe(coroutine, connection_loop)
                future.add_done_callback(lambda completed: completed.exception())
                return True
        return False

    async def broadcast(self, channel: str, data: dict) -> None:
        stale: list[WebSocket] = []
        current_loop = asyncio.get_running_loop()
        for websocket, channels in list(self.active_connections.items()):
            if channels and channel not in channels:
                continue
            try:
                message = {"channel": channel, **data}
                connection_loop = self._connection_loops.get(websocket)
                if connection_loop is current_loop:
                    await websocket.send_json(message)
                elif connection_loop is not None and connection_loop.is_running():
                    future = asyncio.run_coroutine_threadsafe(
                        websocket.send_json(message),
                        connection_loop,
                    )
                    await asyncio.wrap_future(future)
                else:
                    stale.append(websocket)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(websocket)


manager = ConnectionManager()
