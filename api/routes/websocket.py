from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from observatory.scheduler.ws_manager import manager

router = APIRouter(tags=["observatory-websocket"])


@router.websocket("/ws/observatory")
async def observatory_socket(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            payload = await websocket.receive_json()
            if payload.get("action") == "subscribe":
                channels = payload.get("channels", [])
                if isinstance(channels, list):
                    manager.subscribe(websocket, [str(channel) for channel in channels])
                    await websocket.send_json(
                        {"channel": "system", "timestamp": None, "data": {"subscribed": channels}}
                    )
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
