"""WebSocket connection manager for observatory live updates."""
from __future__ import annotations

from fastapi import WebSocket


class ConnectionManager:
    """Track WebSocket clients and their channel subscriptions."""

    def __init__(self) -> None:
        self.active_connections: dict[WebSocket, set[str]] = {}

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections[websocket] = set()

    def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.pop(websocket, None)

    def subscribe(self, websocket: WebSocket, channels: list[str]) -> None:
        if websocket in self.active_connections:
            self.active_connections[websocket].update(channels)

    async def broadcast(self, channel: str, data: dict) -> None:
        stale: list[WebSocket] = []
        for websocket, channels in self.active_connections.items():
            if channels and channel not in channels:
                continue
            try:
                await websocket.send_json({"channel": channel, **data})
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(websocket)


manager = ConnectionManager()
