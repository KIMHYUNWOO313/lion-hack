"""In-memory room participant registry for WebRTC signaling."""

import asyncio
from collections import defaultdict

_rooms: dict[str, dict[str, dict]] = defaultdict(dict)
_lock = asyncio.Lock()


async def add_participant(room_id: str, participant_id: str, name: str, channel_name: str) -> list[dict]:
    async with _lock:
        _rooms[room_id][participant_id] = {"name": name, "channel": channel_name}
        return [
            {"participantId": pid, "participantName": info["name"]}
            for pid, info in _rooms[room_id].items()
            if pid != participant_id
        ]


async def remove_participant(room_id: str, participant_id: str) -> None:
    async with _lock:
        _rooms[room_id].pop(participant_id, None)
        if not _rooms[room_id]:
            _rooms.pop(room_id, None)


async def get_participants(room_id: str) -> dict[str, dict]:
    async with _lock:
        return dict(_rooms.get(room_id, {}))


async def get_channel(room_id: str, participant_id: str) -> str | None:
    async with _lock:
        info = _rooms[room_id].get(participant_id)
        return info["channel"] if info else None
